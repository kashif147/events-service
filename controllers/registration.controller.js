const mongoose = require("mongoose");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Course = require("../models/course.model.js");
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const {
  checkAttendeeDuplicates,
  getProfileMembershipNumber,
} = require("../services/profileLookup.client.js");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");
const { resolveLookupNamesByIds } = require("../services/lookup.client.js");
const {
  determinePriceCategory,
  resolveAmount,
  resolveLineItemsAmount,
} = require("../services/pricingResolution.service.js");
const {
  claimRegistrationForApproval,
  releaseRegistrationClaim,
  finalizeRegistrationApproval,
  isEligibleForAutoApproval,
} = require("../services/registrationApproval.service.js");

/**
 * Downstream axios calls (account-service, profile-service) can legitimately
 * reject with a 4xx of their own (e.g. account-service's 409 when a Payment
 * write trips a unique index) - surface that real status/message instead of
 * flattening every non-AppError, non-Mongo-duplicate error into an opaque
 * 500 "Request failed with status code 409".
 */
function appErrorFromUpstream(error, fallbackMessage) {
  if (error?.isAxiosError && error.response) {
    const status = error.response.status;
    const upstreamMessage =
      error.response.data?.error?.message || error.response.data?.message || error.message;
    if (status >= 400 && status < 500) {
      return new AppError(
        upstreamMessage || fallbackMessage,
        status,
        error.response.data?.error?.code || "UPSTREAM_ERROR",
        error.response.data?.error && typeof error.response.data.error === "object"
          ? { details: error.response.data.error }
          : {},
      );
    }
  }
  return AppError.internalServerError(error?.message || fallbackMessage);
}

const LINE_ITEM_TIER_KEYS = [
  "MEMBER",
  "NON_MEMBER",
  "EARLY_BIRD_MEMBER",
  "EARLY_BIRD_NON_MEMBER",
  "STUDENT",
  "GROUP_STUDENT",
];

// Legacy priceCategory value for display/reporting when the CRM's lineItems
// flow resolves to a single tier - "mixed" is used instead when more than
// one tier is purchased together in the same registration.
function legacyPriceCategoryForTierKey(tierKey) {
  if (tierKey === "STUDENT") return "student";
  if (tierKey === "GROUP_STUDENT") return "group_student";
  return "standard";
}
const {
  createRegistrationPaymentIntent,
  postManualRegistrationPayment,
  cancelPaymentIntent,
  voidManualRegistrationPayment,
} = require("../services/accountService.client.js");
const {
  publishRegistrationCreated,
  publishRegistrationConfirmed,
  publishRegistrationCancelled,
} = require("../rabbitMQ/publishers/registration.events.publisher.js");

/** Sum seats already booked (active registrations) for an event or a specific session within it. */
async function getBookedSeats({ tenantId, eventId, sessionId }) {
  const match = {
    tenantId,
    eventId: new mongoose.Types.ObjectId(eventId),
    status: { $ne: "cancelled" },
    isDeleted: { $ne: true },
  };
  if (sessionId) match.sessionIds = new mongoose.Types.ObjectId(sessionId);

  const [result] = await Registration.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$quantity", 1] } } } },
  ]);
  return result?.total || 0;
}

/**
 * Event/Course product metadata for GL posting - the same productCode/
 * eventCategoryCode fields resolveAmount() reads at creation time
 * (pricingResolution.service.js), needed again here because Registration
 * itself never persists these two fields.
 */
async function resolveProductMetadata({ tenantId, registrationType, eventId, courseId }) {
  if (registrationType === "course") {
    const course = await Course.findOne({ _id: courseId, tenantId }).select("productCode").lean();
    return { productCode: course?.productCode || null, eventCategoryCode: null };
  }
  const event = await Event.findOne({ _id: eventId, tenantId })
    .select("productCode eventCategoryLookupCode")
    .lean();
  return { productCode: event?.productCode || null, eventCategoryCode: event?.eventCategoryLookupCode || null };
}

async function createRegistration(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const {
      registrationType,
      eventId,
      courseId,
      sessionIds,
      profile,
      paymentMethod,
      registeredVia,
      registeredByUserId,
      quantity,
      lineItems,
    } = req.body || {};

    if (!registrationType || !["event", "course"].includes(registrationType)) {
      return next(AppError.badRequest("registrationType must be 'event' or 'course'"));
    }
    if (registrationType === "event" && !eventId) {
      return next(AppError.badRequest("eventId is required for event registrations"));
    }
    if (registrationType === "course" && !courseId) {
      return next(AppError.badRequest("courseId is required for course registrations"));
    }
    if (!profile || !profile.email) {
      return next(AppError.badRequest("profile.email is required"));
    }
    if (!registeredVia || !["crm", "portal", "mobile"].includes(registeredVia)) {
      return next(AppError.badRequest("registeredVia must be 'crm', 'portal' or 'mobile'"));
    }

    // Multi-tier CRM flow: several {tierKey, quantity} lines summed into one
    // registration/payment. No lineItems (portal/mobile, or CRM with a
    // single tier) falls through to the legacy single-quantity path below.
    const hasLineItems = Array.isArray(lineItems) && lineItems.length > 0;
    if (hasLineItems && registrationType !== "event") {
      return next(AppError.badRequest("lineItems is only supported for event registrations"));
    }
    if (hasLineItems) {
      for (const line of lineItems) {
        if (!LINE_ITEM_TIER_KEYS.includes(line?.tierKey)) {
          return next(AppError.badRequest(`Invalid lineItems.tierKey: ${line?.tierKey}`));
        }
        if (!Number.isInteger(line?.quantity) || line.quantity < 1) {
          return next(AppError.badRequest(`lineItems.quantity for ${line?.tierKey} must be a positive integer`));
        }
      }
    }

    const seatQuantity = hasLineItems
      ? lineItems.reduce((sum, line) => sum + line.quantity, 0)
      : quantity != null
        ? Number(quantity)
        : 1;
    if (!Number.isInteger(seatQuantity) || seatQuantity < 1) {
      return next(AppError.badRequest("quantity must be a positive integer"));
    }

    // 1. Enforce seat capacity, if the event/session(s) declare one, before
    // doing anything else (fail fast rather than creating an attendee
    // Profile only to reject the booking).
    let event = null;
    if (registrationType === "event") {
      event = await Event.findOne({ _id: eventId, tenantId }).lean();
      if (!event) return next(AppError.notFound("Event not found"));

      if (event.capacity != null) {
        const booked = await getBookedSeats({ tenantId, eventId });
        const remaining = event.capacity - booked;
        if (seatQuantity > remaining) {
          return next(AppError.badRequest(`Only ${Math.max(remaining, 0)} seat(s) remaining for this event`));
        }
      }

      if (Array.isArray(sessionIds) && sessionIds.length > 0) {
        const sessions = await EventSession.find({ _id: { $in: sessionIds }, tenantId, eventId }).lean();
        for (const session of sessions) {
          if (session.capacity == null) continue;
          const bookedForSession = await getBookedSeats({ tenantId, eventId, sessionId: session._id });
          const remaining = session.capacity - bookedForSession;
          if (seatQuantity > remaining) {
            return next(
              AppError.badRequest(`Only ${Math.max(remaining, 0)} seat(s) remaining for session "${session.label}"`),
            );
          }
        }
      }
    }

    // 2. Record a duplicate-review verdict - Profile creation/linking is
    // deferred to CRM approval (see the /approve endpoint) for every
    // registration, regardless of registeredVia or whether the caller
    // already supplied a profileId. No Profile is created or written here.
    let duplicateReview;
    let candidateProfileId = null;
    let candidateMembershipNumber = null;
    if (profile.profileId) {
      // CRM already searched and picked a known profile - trust that
      // selection outright, no fuzzy scoring needed. Still resolve the real
      // membershipNumber server-side rather than trusting the frontend.
      candidateProfileId = profile.profileId;
      candidateMembershipNumber = await getProfileMembershipNumber({ tenantId, profileId: candidateProfileId });
      duplicateReview = { status: "CONFIRMED_LINK", matchedProfileId: candidateProfileId };
    } else {
      const dupResult = await checkAttendeeDuplicates({
        tenantId,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        addressLine1: profile.addressLine1,
        townCity: profile.townCity,
        countyState: profile.countyState,
        eircode: profile.eircode,
        country: profile.country,
      });
      if (dupResult?.resolution === "exact") {
        candidateProfileId = dupResult.profileId;
        candidateMembershipNumber = dupResult.membershipNumber || null;
        duplicateReview = { status: "EXACT_MATCH", matchedProfileId: candidateProfileId };
      } else if (dupResult?.resolution === "review" && dupResult.candidates?.length) {
        duplicateReview = {
          status: "POTENTIAL_MATCH",
          matchedProfileId: null,
          matchSummary: dupResult.candidates,
        };
      } else {
        duplicateReview = { status: "NO_MATCH", matchedProfileId: null };
      }
    }

    // Everything from here on can still fail (pricing, the Registration
    // write, or taking payment) - if it does, roll back rather than leaving
    // a half-created Registration with no successful payment behind.
    let registration = null;
    try {
      // 3. Determine real (verified) membership status/category - used for
      // the isMemberAtRegistration/display flag always, and (legacy
      // single-tier path only) to auto-derive which pricing tier applies. A
      // profile with a membershipNumber but a lapsed/cancelled subscription
      // still counts as a non-member. Uses the CANDIDATE profile (may be
      // null for POTENTIAL_MATCH/NO_MATCH) - getActiveMembership already
      // tolerates a missing profileId, pricing as non-member until approval
      // resolves the real Profile.
      const { isActiveMember, membershipCategory } = await getActiveMembership({
        profileId: candidateProfileId,
        tenantId,
        req,
      });

      // 4. Price the registration. lineItems (CRM multi-tier flow): the
      // operator explicitly chose which of the event's own trusted prices to
      // apply to how many seats - summed into one amount/priceBreakdown so
      // account-service still sees exactly one registration -> one payment.
      // Otherwise (portal/mobile, or a CRM submission with a single tier):
      // legacy path, auto-deriving the tier from verified membership.
      let amount;
      let currency;
      let productCode;
      let eventCategoryCode;
      let priceBreakdown = [];
      let seatPriceCategory;
      if (hasLineItems) {
        const resolved = await resolveLineItemsAmount({ tenantId, eventId, lineItems });
        amount = resolved.amount;
        currency = resolved.currency;
        productCode = resolved.productCode;
        eventCategoryCode = resolved.eventCategoryCode;
        priceBreakdown = resolved.priceBreakdown;
        seatPriceCategory =
          lineItems.length === 1 ? legacyPriceCategoryForTierKey(lineItems[0].tierKey) : "mixed";
      } else {
        seatPriceCategory = event
          ? determinePriceCategory({
              isActiveMember,
              membershipCategory,
              quantity: seatQuantity,
              entity: event,
            })
          : "standard";
        const resolved = await resolveAmount({
          tenantId,
          registrationType,
          eventId,
          courseId,
          sessionIds,
          isMember: isActiveMember,
          priceCategory: seatPriceCategory,
          quantity: seatQuantity,
        });
        amount = resolved.amount;
        currency = resolved.currency;
        productCode = resolved.productCode;
        eventCategoryCode = resolved.eventCategoryCode;
      }

      const method = paymentMethod || "stripe";
      // Every registration starts pending_review now, regardless of payment
      // method - Profile creation/linking and payment capture/GL-posting
      // both happen only at CRM approval (see the /approve endpoint), never
      // here. status/paymentStatus stay "pending" for every method until
      // then; the Stripe listener flips paymentStatus to "authorized" once
      // the card is confirmed (still pre-approval - see
      // payment.status.listener.js).

      registration = await Registration.create({
        tenantId,
        registrationType,
        eventId: registrationType === "event" ? eventId : null,
        courseId: registrationType === "course" ? courseId : null,
        sessionIds: sessionIds || [],
        quantity: seatQuantity,
        priceCategory: seatPriceCategory,
        priceBreakdown,
        profileId: null,
        membershipNumber: candidateMembershipNumber,
        isMemberAtRegistration: isActiveMember,
        approvalStatus: "pending_review",
        duplicateReview,
        attendeeSnapshot: {
          firstName: profile.firstName || null,
          lastName: profile.lastName || null,
          email: profile.email,
          phone: profile.phone || null,
          workLocation: profile.workLocation || null,
          grade: profile.grade || null,
          nmbiNumber: profile.nmbiNumber || null,
          addressLine1: profile.addressLine1 || null,
          addressLine2: profile.addressLine2 || null,
          townCity: profile.townCity || null,
          countyState: profile.countyState || null,
          eircode: profile.eircode || null,
          country: profile.country || null,
        },
        amount,
        currency,
        paymentMethod: method,
        paymentStatus: "pending",
        status: "pending",
        registeredVia,
        registeredByUserId: registeredByUserId || null,
      });

      // 5. Authorize/record payment - never captured/posted here. Only
      // announce the registration once it actually has a payment attached -
      // never for one that's about to be rolled back below.
      let paymentPayload = null;
      if (method === "stripe") {
        const intent = await createRegistrationPaymentIntent({
          req,
          tenantId,
          registrationId: String(registration._id),
          profileId: candidateProfileId || undefined,
          membershipNumber: candidateMembershipNumber,
          amount,
          currency,
          productCode,
          eventCategoryCode,
          purpose: registrationType === "course" ? "courseRegistration" : "eventRegistration",
        });
        registration.paymentId = intent?.paymentId || null;
        registration.stripePaymentIntentId = intent?.paymentIntentId || null;
        await registration.save();
        paymentPayload = { clientSecret: intent?.clientSecret, checkoutUrl: intent?.checkoutUrl };
        await publishRegistrationCreated(registration, tenantId);
      } else {
        const manual = await postManualRegistrationPayment({
          req,
          tenantId,
          registrationId: String(registration._id),
          profileId: candidateProfileId || undefined,
          membershipNumber: candidateMembershipNumber,
          productCode,
          eventCategoryCode,
          amount,
          currency,
          method,
        });
        registration.paymentId = manual?.paymentId || null;
        await registration.save();
        await publishRegistrationCreated(registration, tenantId);
        // No publishRegistrationConfirmed here anymore - manual/comp/invoice
        // payments are recorded (not posted) at intake now too; confirmation
        // waits for approval - immediately below for an unambiguous CRM
        // registration, otherwise from a CRM reviewer later (see
        // isEligibleForAutoApproval).
        if (isEligibleForAutoApproval(registration)) {
          const claimed = await claimRegistrationForApproval({ id: registration._id, tenantId });
          if (claimed) {
            try {
              registration = await finalizeRegistrationApproval({
                claimed,
                req,
                tenantId,
                reviewerId: registeredByUserId || null,
              });
            } catch (autoApproveError) {
              // Registration + payment already succeeded - don't fail the
              // whole request over an auto-approve hiccup. Release the claim
              // and leave it pending_review for a CRM user to approve
              // manually instead.
              await releaseRegistrationClaim({ id: claimed._id, tenantId });
            }
          }
        }
      }

      return res.status(201).json({
        success: true,
        data: { registration, payment: paymentPayload },
      });
    } catch (innerError) {
      // Roll back: don't leave a half-created Registration behind just
      // because payment (or pricing) failed after it was created. No Profile
      // rollback needed anymore - nothing is created here.
      if (registration) {
        await Registration.deleteOne({ _id: registration._id, tenantId }).catch(() => {});
      }
      throw innerError;
    }
  } catch (error) {
    if (error instanceof AppError) return next(error);
    // Registration has a unique {tenantId, eventId/courseId, profileId} index -
    // one profile can only have one registration per event/course. Surface
    // that as a clear message instead of the raw Mongo E11000 text.
    if (error?.code === 11000) {
      return next(
        AppError.badRequest(
          "This profile is already registered for this event. Cancel their existing registration first if you need to change the ticket(s).",
        ),
      );
    }
    return next(appErrorFromUpstream(error, "Failed to create registration"));
  }
}

/** Batch-fetch the distinct events referenced by a set of registrations, keyed by id string. */
async function getEventsMapForRegistrations({ tenantId, registrations }) {
  const eventIds = [
    ...new Set(
      registrations
        .filter((r) => r.registrationType === "event" && r.eventId)
        .map((r) => String(r.eventId)),
    ),
  ];
  if (!eventIds.length) return new Map();

  const events = await Event.find({ _id: { $in: eventIds }, tenantId })
    .select(
      "title eventTypeId eventCategoryLookupId eventCategoryLookupCode eventCategoryCode startDate endDate venue isVirtual imageUrl status cpdCredits accreditationBody certificationType",
    )
    .lean();
  return new Map(events.map((ev) => [String(ev._id), ev]));
}

/** Batch-fetch the distinct courses referenced by a set of registrations, keyed by id string. */
async function getCoursesMapForRegistrations({ tenantId, registrations }) {
  const courseIds = [
    ...new Set(
      registrations
        .filter((r) => r.registrationType === "course" && r.courseId)
        .map((r) => String(r.courseId)),
    ),
  ];
  if (!courseIds.length) return new Map();

  const courses = await Course.find({ _id: { $in: courseIds }, tenantId })
    .select("title deliveryMode startDate endDate status")
    .lean();
  return new Map(courses.map((course) => [String(course._id), course]));
}

/** Batch-fetch the distinct sessions a profile registered for, keyed by id string. */
async function getSessionsMapForRegistrations({ tenantId, registrations }) {
  const sessionIds = [
    ...new Set(registrations.flatMap((r) => (r.sessionIds || []).map(String))),
  ];
  if (!sessionIds.length) return new Map();

  const sessions = await EventSession.find({ _id: { $in: sessionIds }, tenantId })
    .select("label date startTime endTime isVirtual")
    .lean();
  return new Map(sessions.map((session) => [String(session._id), session]));
}

const COURSE_DELIVERY_MODE_LABELS = { online: "Online", "in-person": "In-Person", blended: "Blended" };

/** "Virtual" / "In-Person" / "Hybrid" (mixed per-session format) for an event. */
function deriveEventFormat(event, sessions) {
  if (!event) return null;
  if (!sessions.length) return event.isVirtual ? "Virtual" : "In-Person";
  const flags = new Set(sessions.map((s) => Boolean(s.isVirtual ?? event.isVirtual)));
  if (flags.size > 1) return "Hybrid";
  return flags.has(true) ? "Virtual" : "In-Person";
}

/** past: already finished. upcoming: hasn't started. current: in progress (or no end date to compare). */
function classifyTiming(startDate, endDate) {
  const now = Date.now();
  const start = startDate ? new Date(startDate).getTime() : null;
  const end = endDate ? new Date(endDate).getTime() : start;
  if (end != null && end < now) return "past";
  if (start != null && start > now) return "upcoming";
  return "current";
}

/** Merge event/course + session fields onto each registration for the portal's "My Events" list. */
function enrichRegistrationsForProfile(registrations, eventsById, coursesById, sessionsById, eventTypesById) {
  return registrations.map((reg) => {
    const isEvent = reg.registrationType === "event";
    const parent = isEvent
      ? reg.eventId
        ? eventsById.get(String(reg.eventId))
        : null
      : reg.courseId
        ? coursesById.get(String(reg.courseId))
        : null;
    const sessions = (reg.sessionIds || [])
      .map((id) => sessionsById.get(String(id)))
      .filter(Boolean);
    const eventType = isEvent && parent?.eventTypeId ? eventTypesById.get(String(parent.eventTypeId)) : null;

    return {
      ...reg,
      title: parent?.title || null,
      startDate: parent?.startDate || null,
      endDate: parent?.endDate || null,
      // parentStatus (Draft/Published/Cancelled/Completed on the Event/Course)
      // is distinct from reg.status (this registration's pending/confirmed/
      // cancelled) - keep both, don't let one clobber the other.
      parentStatus: parent?.status || null,
      venue: isEvent ? parent?.venue || null : null,
      isVirtual: isEvent ? (parent?.isVirtual ?? null) : null,
      imageUrl: isEvent ? parent?.imageUrl || null : null,
      // "Virtual" / "In-Person" / "Hybrid" for events; delivery mode label for courses.
      format: isEvent
        ? deriveEventFormat(parent, sessions)
        : parent?.deliveryMode
          ? COURSE_DELIVERY_MODE_LABELS[parent.deliveryMode] || parent.deliveryMode
          : null,
      deliveryMode: !isEvent ? parent?.deliveryMode || null : null,
      eventTypeId: isEvent ? parent?.eventTypeId || null : null,
      eventTypeName: isEvent ? eventType?.name || null : null,
      eventCategoryLookupCode: isEvent ? parent?.eventCategoryLookupCode || null : null,
      cpdCredits: isEvent ? (parent?.cpdCredits ?? null) : null,
      accreditationBody: isEvent ? parent?.accreditationBody || null : null,
      certificationType: isEvent ? parent?.certificationType || null : null,
      sessions,
      timing: classifyTiming(parent?.startDate, parent?.endDate),
    };
  });
}

/** Merge event fields onto each registration for grid display (Event Name/Type/Category/Date). */
function enrichRegistrationsWithEvent(registrations, eventsById) {
  return registrations.map((reg) => {
    const event = reg.eventId ? eventsById.get(String(reg.eventId)) : null;
    return {
      ...reg,
      eventTitle: event?.title || null,
      eventTypeId: event?.eventTypeId || null,
      eventCategoryLookupId: event?.eventCategoryLookupId || null,
      eventCategoryLookupCode: event?.eventCategoryLookupCode || null,
      eventCategoryCode: event?.eventCategoryCode || null,
      eventStartDate: event?.startDate || null,
      eventEndDate: event?.endDate || null,
    };
  });
}

async function listRegistrations(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { eventId, courseId, profileId, status, q } = req.query;
    const filter = { tenantId, isDeleted: { $ne: true } };
    if (eventId) filter.eventId = eventId;
    if (courseId) filter.courseId = courseId;
    if (profileId) filter.profileId = profileId;
    if (status) filter.status = status;
    if (q) {
      const escaped = String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { "attendeeSnapshot.firstName": re },
        { "attendeeSnapshot.lastName": re },
        { "attendeeSnapshot.email": re },
      ];
    }

    // No limit - this backs the CRM Attendees grid, which filters/sorts
    // client-side over the full result set (same pattern as listEvents).
    const registrations = await Registration.find(filter).sort({ createdAt: -1 }).lean();
    const eventsById = await getEventsMapForRegistrations({ tenantId, registrations });
    const enriched = enrichRegistrationsWithEvent(registrations, eventsById);
    return res.status(200).json({ success: true, data: enriched });
  } catch (error) {
    return next(appErrorFromUpstream(error, "Failed to list registrations"));
  }
}

async function getRegistrationsByProfile(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { timing } = req.query; // optional: past | current | upcoming

    const registrations = await Registration.find({
      tenantId,
      profileId: req.params.profileId,
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    const [eventsById, coursesById, sessionsById] = await Promise.all([
      getEventsMapForRegistrations({ tenantId, registrations }),
      getCoursesMapForRegistrations({ tenantId, registrations }),
      getSessionsMapForRegistrations({ tenantId, registrations }),
    ]);

    // Event Type is stored as a raw Lookup _id on Event (no cached label, unlike
    // eventCategoryLookupCode) - resolve the distinct ids referenced here to
    // display names in one batched call. Never let a user-service hiccup break
    // the whole "My Events" list - fall back to ids-only if it fails.
    const eventTypeIds = [...new Set([...eventsById.values()].map((ev) => ev.eventTypeId).filter(Boolean))];
    const eventTypesById = eventTypeIds.length
      ? await resolveLookupNamesByIds(eventTypeIds, req, tenantId).catch(() => new Map())
      : new Map();

    let enriched = enrichRegistrationsForProfile(registrations, eventsById, coursesById, sessionsById, eventTypesById);

    if (["past", "current", "upcoming"].includes(timing)) {
      enriched = enriched.filter((reg) => reg.timing === timing);
    }

    return res.status(200).json({ success: true, data: enriched });
  } catch (error) {
    return next(appErrorFromUpstream(error, "Failed to fetch registrations for profile"));
  }
}

async function cancelRegistration(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const registration = await Registration.findOneAndUpdate(
      { _id: req.params.id, tenantId, isDeleted: { $ne: true } },
      // isActive:false frees the unique registration slot for this
      // profile/event(-or-course) so re-registering the same profile no
      // longer 400s with "already registered" (see registration.model.js).
      { $set: { status: "cancelled", isActive: false } },
      { new: true },
    );
    if (!registration) return next(AppError.notFound("Registration not found"));

    await publishRegistrationCancelled(registration, tenantId);

    return res.status(200).json({ success: true, data: registration });
  } catch (error) {
    return next(appErrorFromUpstream(error, "Failed to cancel registration"));
  }
}

/**
 * CRM approval: resolves/links the attendee's Profile (per the
 * duplicateReview verdict recorded at intake, or the reviewer's decision for
 * a POTENTIAL_MATCH), captures the authorized Stripe payment or posts the
 * recorded manual/comp/invoice payment to the GL, and confirms the
 * registration - the only point in this whole flow where a Profile gets
 * created/linked or money actually moves. The atomic
 * {approvalStatus:'pending_review'} -> 'processing' claim below is what
 * makes this safe to call concurrently: only the caller that wins the claim
 * proceeds to capture/post payment, so a Stripe charge or GL entry can never
 * be posted twice for the same registration.
 *
 * Body (only required when duplicateReview.status is POTENTIAL_MATCH):
 *   { decision: 'LINK'|'CREATE_NEW', candidateProfileId? }
 */
async function approveRegistration(req, res, next) {
  const { tenantId } = req.ctx;
  let claimed = null;
  try {
    const { decision, candidateProfileId } = req.body || {};

    claimed = await claimRegistrationForApproval({ id: req.params.id, tenantId });
    if (!claimed) {
      return next(
        AppError.badRequest(
          "This registration is not awaiting approval (already approved, rejected, or not found).",
        ),
      );
    }

    const result = await finalizeRegistrationApproval({
      claimed,
      decision,
      candidateProfileId,
      req,
      tenantId,
      reviewerId: req.ctx?.userId || req.userId || null,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    // Release the claim so a fixable failure (e.g. a transient account-service
    // error) doesn't leave the registration stuck in "processing" forever.
    if (claimed) {
      await releaseRegistrationClaim({ id: claimed._id, tenantId });
    }
    if (error instanceof AppError) return next(error);
    return next(appErrorFromUpstream(error, "Failed to approve registration"));
  }
}

/**
 * CRM rejection of a pending-review registration - releases the Stripe
 * authorization (cancelPaymentIntent, no refund since nothing was captured)
 * or voids the recorded-but-unposted manual/comp/invoice payment (nothing
 * was posted to the GL, so nothing to reverse), then cancels the
 * registration and frees the seat.
 */
async function rejectRegistration(req, res, next) {
  const { tenantId } = req.ctx;
  try {
    const registration = await Registration.findOneAndUpdate(
      { _id: req.params.id, tenantId, approvalStatus: "pending_review" },
      { $set: { approvalStatus: "processing" } },
      { new: true },
    );
    if (!registration) {
      return next(
        AppError.badRequest(
          "This registration is not awaiting approval (already approved, rejected, or not found).",
        ),
      );
    }

    try {
      if (registration.paymentMethod === "stripe") {
        if (registration.stripePaymentIntentId) {
          await cancelPaymentIntent({ req, tenantId, paymentIntentId: registration.stripePaymentIntentId });
        }
      } else if (registration.paymentId) {
        await voidManualRegistrationPayment({ req, tenantId, paymentId: registration.paymentId });
      }
    } catch (paymentError) {
      await Registration.updateOne(
        { _id: registration._id, tenantId, approvalStatus: "processing" },
        { $set: { approvalStatus: "pending_review" } },
      ).catch(() => {});
      throw paymentError;
    }

    registration.status = "cancelled";
    registration.approvalStatus = "rejected";
    registration.isActive = false;
    await registration.save();

    await publishRegistrationCancelled(registration, tenantId);

    return res.status(200).json({ success: true, data: registration });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(appErrorFromUpstream(error, "Failed to reject registration"));
  }
}

// Thin passthrough to profile-service's read-only duplicate check, so the CRM
// (and portal/mobile) never call profile-service directly for this - keeps
// the same service-boundary pattern as findOrCreateAttendeeProfile above.
async function checkNewAttendeeDuplicates(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { email, firstName, lastName, phone, addressLine1, townCity, countyState, eircode, country } =
      req.body || {};
    if (!email) return next(AppError.badRequest("email is required"));

    const result = await checkAttendeeDuplicates({
      tenantId,
      email,
      firstName,
      lastName,
      phone,
      addressLine1,
      townCity,
      countyState,
      eircode,
      country,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return next(appErrorFromUpstream(error, "Failed to check attendee duplicates"));
  }
}

module.exports = {
  createRegistration,
  listRegistrations,
  getRegistrationsByProfile,
  cancelRegistration,
  approveRegistration,
  rejectRegistration,
  checkNewAttendeeDuplicates,
};
