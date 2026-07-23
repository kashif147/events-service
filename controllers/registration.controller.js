const mongoose = require("mongoose");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const {
  findOrCreateAttendeeProfile,
  checkAttendeeDuplicates,
} = require("../services/profileLookup.client.js");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");
const {
  determinePriceCategory,
  resolveAmount,
  resolveLineItemsAmount,
} = require("../services/pricingResolution.service.js");

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

    // 2. Resolve (or create) the attendee's Profile - never enters the
    // membership application pipeline.
    let profileId = profile.profileId;
    let membershipNumber = null;
    if (!profileId) {
      const resolved = await findOrCreateAttendeeProfile({
        tenantId,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        workLocation: profile.workLocation,
        grade: profile.grade,
        addressLine1: profile.addressLine1,
        addressLine2: profile.addressLine2,
        townCity: profile.townCity,
        countyState: profile.countyState,
        eircode: profile.eircode,
        country: profile.country,
      });
      profileId = resolved.profileId;
      membershipNumber = resolved.membershipNumber;
    }

    // 3. Determine real (verified) membership status/category - used for the
    // isMemberAtRegistration/display flag always, and (legacy single-tier
    // path only) to auto-derive which pricing tier applies. A profile with a
    // membershipNumber but a lapsed/cancelled subscription still counts as a
    // non-member.
    const { isActiveMember, membershipCategory } = await getActiveMembership({
      profileId,
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
    const initialStatus = method === "stripe" ? "pending" : "confirmed";
    const initialPaymentStatus =
      method === "stripe" ? "pending" : method === "comp" ? "waived" : "manual";

    const registration = await Registration.create({
      tenantId,
      registrationType,
      eventId: registrationType === "event" ? eventId : null,
      courseId: registrationType === "course" ? courseId : null,
      sessionIds: sessionIds || [],
      quantity: seatQuantity,
      priceCategory: seatPriceCategory,
      priceBreakdown,
      profileId,
      membershipNumber,
      isMemberAtRegistration: isActiveMember,
      attendeeSnapshot: {
        firstName: profile.firstName || null,
        lastName: profile.lastName || null,
        email: profile.email,
        phone: profile.phone || null,
        workLocation: profile.workLocation || null,
        grade: profile.grade || null,
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
      paymentStatus: initialPaymentStatus,
      status: initialStatus,
      registeredVia,
      registeredByUserId: registeredByUserId || null,
    });

    await publishRegistrationCreated(registration, tenantId);

    // 5. Take payment.
    let paymentPayload = null;
    if (method === "stripe") {
      const intent = await createRegistrationPaymentIntent({
        req,
        tenantId,
        registrationId: String(registration._id),
        profileId,
        membershipNumber,
        amount,
        currency,
        productCode,
        eventCategoryCode,
        purpose: registrationType === "course" ? "courseRegistration" : "eventRegistration",
      });
      registration.paymentId = intent?.paymentId || null;
      await registration.save();
      paymentPayload = { clientSecret: intent?.clientSecret, checkoutUrl: intent?.checkoutUrl };
    } else {
      const manual = await postManualRegistrationPayment({
        req,
        tenantId,
        registrationId: String(registration._id),
        profileId,
        membershipNumber,
        productCode,
        eventCategoryCode,
        amount,
        currency,
        method,
      });
      registration.paymentId = manual?.paymentId || null;
      await registration.save();
      await publishRegistrationConfirmed(registration, tenantId);
    }

    return res.status(201).json({
      success: true,
      data: { registration, payment: paymentPayload },
    });
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
    return next(AppError.internalServerError(error.message || "Failed to create registration"));
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
    .select("title eventTypeId eventCategoryLookupId eventCategoryLookupCode eventCategoryCode startDate endDate")
    .lean();
  return new Map(events.map((ev) => [String(ev._id), ev]));
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
    return next(AppError.internalServerError(error.message || "Failed to list registrations"));
  }
}

async function getRegistrationsByProfile(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const registrations = await Registration.find({
      tenantId,
      profileId: req.params.profileId,
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, data: registrations });
  } catch (error) {
    return next(
      AppError.internalServerError(error.message || "Failed to fetch registrations for profile"),
    );
  }
}

async function cancelRegistration(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const registration = await Registration.findOneAndUpdate(
      { _id: req.params.id, tenantId, isDeleted: { $ne: true } },
      { $set: { status: "cancelled" } },
      { new: true },
    );
    if (!registration) return next(AppError.notFound("Registration not found"));

    await publishRegistrationCancelled(registration, tenantId);

    return res.status(200).json({ success: true, data: registration });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to cancel registration"));
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
    return next(AppError.internalServerError(error.message || "Failed to check attendee duplicates"));
  }
}

module.exports = {
  createRegistration,
  listRegistrations,
  getRegistrationsByProfile,
  cancelRegistration,
  checkNewAttendeeDuplicates,
};
