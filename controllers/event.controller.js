const crypto = require("crypto");
const mongoose = require("mongoose");
const Event = require("../models/event.model.js");
const azureBlob = require("../services/azure.blob.service.js");
const EventSession = require("../models/eventSession.model.js");
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const { resolveEventCategoryLookup } = require("../services/lookup.client.js");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");
const {
  determinePriceCategory,
  resolveUnitPriceForEntity,
} = require("../services/pricingResolution.service.js");
const { cancelPaymentIntent, voidManualRegistrationPayment } = require("../services/accountService.client.js");
const { publishRegistrationCancelled } = require("../rabbitMQ/publishers/registration.events.publisher.js");
const {
  publishEventCancelled,
  publishEventCompleted,
  publishEventUnpublished,
} = require("../rabbitMQ/publishers/event.lifecycle.publisher.js");
const { applyAttendanceRollupForCompletedEvent } = require("../services/attendanceRollup.service.js");
const { maybeIssueCertificatesForCompletedEvent } = require("../services/autoCertificate.service.js");
const { parseMeetingLink } = require("../services/meetingLinkParser.js");

/** Builds the EventSession.meeting sub-object from a raw pasted joinUrl (the
 * CreateEventDrawer/ScheduleManagementDrawer "Meeting Link" field) - detects
 * Zoom/Teams so the attendance sync job knows which API to call, see
 * meetingLinkParser.js. A falsy joinUrl clears the field entirely. */
function buildMeetingField(joinUrl, organizerUpn) {
  if (!joinUrl) {
    return { provider: null, joinUrl: null, externalMeetingId: null, organizerUpn: null, attendanceSyncStatus: "pending" };
  }
  const { provider, externalMeetingId } = parseMeetingLink(joinUrl);
  // organizerUpn only matters for Teams (Graph looks the meeting up by
  // organizer + exact joinUrl match - see msGraphMeetings.client.js), but
  // there's no harm storing it regardless of provider.
  return { provider, joinUrl, externalMeetingId, organizerUpn: organizerUpn || null, attendanceSyncStatus: "pending" };
}

// productId/productCode are internal linkage fields into user-service's
// Product record (used for GL/finance mapping and payment amount
// resolution) - strip them from anything sent back to the client.
function omitProductFields(doc) {
  if (!doc) return doc;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const { productId, productCode, ...rest } = plain;
  return rest;
}

// Never trust a client-supplied eventCategoryLookupCode - always re-resolve it
// server-side from eventCategoryLookupId against user-service's live Lookup
// data.
async function resolveEventCategoryLookupCode(eventCategoryLookupId, req, tenantId) {
  if (!eventCategoryLookupId) return null;
  const resolved = await resolveEventCategoryLookup(eventCategoryLookupId, req, tenantId);
  return resolved?.code || null;
}

const VALID_TIER_TYPES = ["EARLY_BIRD_MEMBER", "EARLY_BIRD_NON_MEMBER", "STUDENT", "GROUP_STUDENT"];

// Validates an optional pricingTiers array on an Event or EventSession
// payload - throws AppError.badRequest on any violation. At most one active
// tier per type is allowed so price resolution stays deterministic.
function validatePricingTiers(pricingTiers) {
  if (pricingTiers == null) return;
  if (!Array.isArray(pricingTiers)) {
    throw AppError.badRequest("pricingTiers must be an array");
  }
  const seenTypes = new Set();
  for (const tier of pricingTiers) {
    if (!VALID_TIER_TYPES.includes(tier?.tierType)) {
      throw AppError.badRequest(`Invalid pricingTiers.tierType: ${tier?.tierType}`);
    }
    if (tier.isActive === false) continue;
    if (seenTypes.has(tier.tierType)) {
      throw AppError.badRequest(`Only one active ${tier.tierType} tier is allowed`);
    }
    seenTypes.add(tier.tierType);
    if (typeof tier.price !== "number" || Number.isNaN(tier.price) || tier.price < 0) {
      throw AppError.badRequest(`${tier.tierType} price must be a number of 0 or more`);
    }
    if (["EARLY_BIRD_MEMBER", "EARLY_BIRD_NON_MEMBER"].includes(tier.tierType) && !tier.cutoffDate) {
      throw AppError.badRequest(`${tier.tierType} requires a cutoffDate`);
    }
    if (tier.tierType === "GROUP_STUDENT" && (!tier.minGroupSize || tier.minGroupSize < 2)) {
      throw AppError.badRequest("GROUP_STUDENT requires minGroupSize of 2 or more");
    }
  }
}

async function listEvents(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { status, from, to, q, eventCategoryCode } = req.query;

    const filter = { tenantId, isDeleted: { $ne: true } };
    // status omitted -> all events; status=Published -> published only
    // (same param also covers Draft/Cancelled/Completed).
    if (status) filter.status = status;
    // Query param is named eventCategoryCode for the portal's existing API
    // contract; it maps directly onto the one stored category field.
    if (eventCategoryCode) filter.eventCategoryLookupCode = eventCategoryCode;
    if (from || to) {
      filter.startDate = {};
      if (from) filter.startDate.$gte = new Date(from);
      if (to) filter.startDate.$lte = new Date(to);
    }
    if (q) filter.title = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const events = await Event.find(filter).sort({ startDate: 1 }).lean();
    return res.status(200).json({ success: true, data: events.map(omitProductFields) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list events"));
  }
}

/** Seats booked per event/session for this tenant, keyed by eventId (total) and each sessionId. */
async function getSeatsBookedMap({ tenantId, eventId }) {
  const rows = await Registration.aggregate([
    {
      $match: {
        tenantId,
        eventId: new mongoose.Types.ObjectId(eventId),
        status: { $ne: "cancelled" },
        isDeleted: { $ne: true },
      },
    },
    { $project: { quantity: { $ifNull: ["$quantity", 1] }, sessionIds: 1 } },
  ]);

  let eventTotal = 0;
  const bySession = new Map();
  for (const row of rows) {
    eventTotal += row.quantity;
    for (const sessionId of row.sessionIds || []) {
      const key = String(sessionId);
      bySession.set(key, (bySession.get(key) || 0) + row.quantity);
    }
  }
  return { eventTotal, bySession };
}

async function getEventById(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const event = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    }).lean();
    if (!event) return next(AppError.notFound("Event not found"));

    const sessions = await EventSession.find({
      tenantId,
      eventId: event._id,
      isDeleted: { $ne: true },
    })
      .sort({ date: 1 })
      .lean();

    const { eventTotal, bySession } = await getSeatsBookedMap({ tenantId, eventId: event._id });
    const sessionsWithSeats = sessions.map((session) => ({
      ...omitProductFields(session),
      seatsBooked: bySession.get(String(session._id)) || 0,
    }));

    return res.status(200).json({
      success: true,
      data: { ...omitProductFields(event), seatsBooked: eventTotal, sessions: sessionsWithSeats },
    });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch event"));
  }
}

// Live price quote for the CRM/portal registration UI - resolves the exact
// same rules createRegistration uses (via pricingResolution.service.js), so
// what's shown here always matches what's actually charged. profileId is
// optional (a new/unlinked attendee quotes as a non-member).
async function getEventPriceQuote(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { profileId } = req.query;
    const quantity = req.query.quantity != null ? Number(req.query.quantity) : 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      return next(AppError.badRequest("quantity must be a positive integer"));
    }

    const event = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    }).lean();
    if (!event) return next(AppError.notFound("Event not found"));

    const { isActiveMember, membershipCategory } = await getActiveMembership({
      profileId: profileId || null,
      tenantId,
      req,
    });

    const priceCategory = determinePriceCategory({
      isActiveMember,
      membershipCategory,
      quantity,
      entity: event,
    });
    const { price: unitPrice, appliedTier } = resolveUnitPriceForEntity({
      entity: event,
      entityLabel: event.title,
      isMember: isActiveMember,
      priceCategory,
      quantity,
      now: new Date(),
    });

    return res.status(200).json({
      success: true,
      data: {
        isActiveMember,
        membershipCategory,
        priceCategory,
        appliedTier,
        unitPrice,
        quantity,
        totalAmount: unitPrice * quantity,
        currency: "eur",
        memberPrice: event.memberPrice,
        nonMemberPrice: event.nonMemberPrice,
        pricingTiers: event.pricingTiers || [],
      },
    });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to compute price quote"));
  }
}

async function createEvent(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const {
      title,
      description,
      productId,
      productCode,
      eventCategoryLookupId,
      eventTypeId,
      memberPrice,
      nonMemberPrice,
      pricingTiers,
      venueId,
      venue,
      isVirtual,
      imageUrl,
      startDate,
      endDate,
      capacity,
      status,
      isActive,
      cpdCredits,
      accreditationBody,
      certificationType,
      autoIssueOnFinish,
      costs,
      refundPolicyDays,
      allowPartialAttendance,
      perDayPricing,
    } = req.body || {};

    if (!title || !startDate || !endDate) {
      return next(AppError.badRequest("title, startDate and endDate are required"));
    }
    if (!eventCategoryLookupId) {
      return next(AppError.badRequest("eventCategoryLookupId is required"));
    }
    if (!venueId) {
      return next(AppError.badRequest("venueId is required"));
    }
    if (!description || !String(description).replace(/<[^>]*>/g, "").trim()) {
      return next(AppError.badRequest("description is required"));
    }
    if (refundPolicyDays === undefined || refundPolicyDays === null || refundPolicyDays === "") {
      return next(AppError.badRequest("refundPolicyDays is required"));
    }
    if (typeof refundPolicyDays !== "number" || Number.isNaN(refundPolicyDays) || refundPolicyDays < 0) {
      return next(AppError.badRequest("refundPolicyDays must be a number of 0 or more"));
    }

    let eventCategoryLookupCode;
    try {
      eventCategoryLookupCode = await resolveEventCategoryLookupCode(
        eventCategoryLookupId,
        req,
        tenantId,
      );
    } catch (resolveError) {
      return next(AppError.badRequest(resolveError.message));
    }

    try {
      validatePricingTiers(pricingTiers);
    } catch (validationError) {
      return next(validationError);
    }

    let event = await Event.create({
      tenantId,
      title,
      description,
      productId,
      productCode,
      eventCategoryLookupId: eventCategoryLookupId || null,
      eventCategoryLookupCode,
      eventTypeId,
      memberPrice,
      nonMemberPrice,
      pricingTiers,
      venueId,
      venue,
      isVirtual,
      imageUrl,
      startDate,
      endDate,
      capacity,
      status: status || "Draft",
      isActive,
      cpdCredits,
      accreditationBody,
      certificationType,
      autoIssueOnFinish,
      costs,
      refundPolicyDays,
      allowPartialAttendance,
      perDayPricing,
      createdBy: userId,
      createdByEmail: req.user?.email || null,
      updatedBy: userId,
      updatedByEmail: req.user?.email || null,
    });

    return res.status(201).json({ success: true, data: omitProductFields(event) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to create event"));
  }
}

async function updateEvent(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const existing = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!existing) return next(AppError.notFound("Event not found"));

    const body = req.body || {};

    if (existing.status === "Published") {
      // Every Published status transition (unpublish/cancel/complete) carries
      // side effects (bulk registration handling, notifications, refunds,
      // completion gating) that a bare field write can't safely perform - see
      // unpublishEvent/cancelEvent/completeEvent below. Only isActive/
      // description remain editable through the generic route.
      const disallowedKey = Object.keys(body).find(
        (key) => key !== "isActive" && key !== "description",
      );
      if (disallowedKey) {
        return next(
          AppError.badRequest(
            "Published events can only have their active flag or description changed here - use /:id/unpublish, /:id/cancel or /:id/complete to change status",
          ),
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "eventCategoryLookupId")) {
      try {
        body.eventCategoryLookupCode = await resolveEventCategoryLookupCode(
          body.eventCategoryLookupId,
          req,
          tenantId,
        );
      } catch (resolveError) {
        return next(AppError.badRequest(resolveError.message));
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "pricingTiers")) {
      try {
        validatePricingTiers(body.pricingTiers);
      } catch (validationError) {
        return next(validationError);
      }
    }

    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, tenantId, isDeleted: { $ne: true } },
      { $set: { ...body, updatedBy: userId, updatedByEmail: req.user?.email || null } },
      { new: true, runValidators: true },
    );
    if (!event) return next(AppError.notFound("Event not found"));

    return res.status(200).json({ success: true, data: omitProductFields(event) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to update event"));
  }
}

/** Latest session date for a multi-day event, else the event's own endDate. */
async function getLastRelevantDate(tenantId, eventId, event) {
  const latestSession = await EventSession.findOne({ tenantId, eventId, isDeleted: { $ne: true } })
    .sort({ date: -1 })
    .select("date")
    .lean();
  return latestSession?.date || event.endDate;
}

async function unpublishEvent(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const existing = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!existing) return next(AppError.notFound("Event not found"));
    if (existing.status !== "Published") {
      return next(AppError.badRequest("Only Published events can be unpublished"));
    }

    // Registrations are a separate collection keyed by eventId - moving the
    // event back to Draft to make changes has no effect on them, nothing to
    // migrate/touch here.
    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { status: "Draft", updatedBy: userId, updatedByEmail: req.user?.email || null } },
      { new: true },
    );

    try {
      await publishEventUnpublished(event, tenantId);
    } catch (err) {
      console.error("[events-service] failed to publish event.unpublished", err.message);
    }

    return res.status(200).json({ success: true, data: omitProductFields(event) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to unpublish event"));
  }
}

/**
 * Whether this registration ever had real money move (a captured Stripe
 * charge, or a manual/comp/invoice payment actually posted to the GL at
 * approval - see registrationApproval.service.js's finalizeRegistrationApproval
 * for the paymentStatus mapping this depends on: stripe->"succeeded",
 * manual/invoice->"manual", comp->"waived"). Only these are refund
 * candidates; "waived" (comp) had nothing collected, and pending
 * (not-yet-approved) registrations only ever have an uncaptured authorization
 * hold or an unposted manual payment - see releasePendingRegistrationPayment.
 */
function isRefundableConfirmedRegistration(registration) {
  if (registration.status !== "confirmed") return false;
  if (registration.paymentMethod === "stripe") return registration.paymentStatus === "succeeded";
  if (["manual", "comp", "invoice"].includes(registration.paymentMethod)) {
    return registration.paymentStatus === "manual";
  }
  return false;
}

/**
 * For a registration that never made it past CRM approval (status:"pending"),
 * release whatever was held rather than refund anything actually posted -
 * mirrors rejectRegistration's exact logic, since nothing was captured/posted
 * for a pending registration.
 */
async function releasePendingRegistrationPayment(req, tenantId, registration) {
  if (registration.paymentMethod === "stripe") {
    if (registration.stripePaymentIntentId) {
      await cancelPaymentIntent({ req, tenantId, paymentIntentId: registration.stripePaymentIntentId });
    }
  } else if (registration.paymentId) {
    await voidManualRegistrationPayment({ req, tenantId, paymentId: registration.paymentId });
  }
}

async function cancelEvent(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const existing = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!existing) return next(AppError.notFound("Event not found"));
    if (existing.status !== "Published") {
      return next(AppError.badRequest("Only Published events can be cancelled"));
    }

    const registrations = await Registration.find({
      tenantId,
      eventId: existing._id,
      isActive: true,
      status: { $in: ["pending", "confirmed"] },
    });

    const refundCandidates = [];
    for (const registration of registrations) {
      const wasConfirmed = registration.status === "confirmed";
      const refundable = wasConfirmed && isRefundableConfirmedRegistration(registration);

      registration.status = "cancelled";
      registration.isActive = false;
      await registration.save();

      if (!wasConfirmed) {
        // Never captured/posted - release the hold/void the unposted
        // payment instead of creating a refund candidate for it.
        try {
          await releasePendingRegistrationPayment(req, tenantId, registration);
        } catch (err) {
          console.error("[events-service] failed to release pending payment during event cancel", {
            registrationId: String(registration._id),
            error: err.message,
          });
        }
      } else if (refundable) {
        refundCandidates.push({
          registrationId: registration._id,
          paymentId: registration.paymentId,
          stripePaymentIntentId: registration.stripePaymentIntentId,
          paymentMethod: registration.paymentMethod,
          amount: registration.amount,
          currency: registration.currency,
          profileId: registration.profileId,
          membershipNumber: registration.membershipNumber,
        });
      }

      try {
        await publishRegistrationCancelled(registration, tenantId);
      } catch (err) {
        console.error("[events-service] failed to publish registration.cancelled during event cancel", {
          registrationId: String(registration._id),
          error: err.message,
        });
      }
    }

    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { status: "Cancelled", updatedBy: userId, updatedByEmail: req.user?.email || null } },
      { new: true },
    );

    try {
      await publishEventCancelled(event, refundCandidates, tenantId);
    } catch (err) {
      console.error("[events-service] failed to publish event.cancelled", err.message);
    }

    return res.status(200).json({ success: true, data: omitProductFields(event) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to cancel event"));
  }
}

/**
 * Shared by the dedicated /:id/complete endpoint and the completion sweep job
 * (jobs/eventCompletionSweep.js) - the atomic status-guarded update is what
 * makes it safe for both to race (a manual complete and the sweep firing at
 * the same moment): whichever gets there first wins, the loser's
 * findOneAndUpdate matches nothing and this returns null rather than erroring.
 */
async function completeEventById({ event, tenantId, actorId, actorEmail }) {
  const updated = await Event.findOneAndUpdate(
    { _id: event._id, tenantId, status: "Published" },
    { $set: { status: "Completed", updatedBy: actorId || null, updatedByEmail: actorEmail || null } },
    { new: true },
  );
  if (!updated) return null;

  try {
    await applyAttendanceRollupForCompletedEvent({ event: updated, tenantId });
  } catch (err) {
    console.error("[events-service] failed to apply attendance rollup on completion", err.message);
  }

  try {
    await maybeIssueCertificatesForCompletedEvent({ event: updated, tenantId });
  } catch (err) {
    console.error("[events-service] failed to auto-issue certificates on completion", err.message);
  }

  try {
    await publishEventCompleted(updated, tenantId);
  } catch (err) {
    console.error("[events-service] failed to publish event.completed", err.message);
  }

  return updated;
}

async function completeEvent(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const existing = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!existing) return next(AppError.notFound("Event not found"));
    if (existing.status !== "Published") {
      return next(AppError.badRequest("Only Published events can be marked Completed"));
    }

    const lastRelevantDate = await getLastRelevantDate(tenantId, existing._id, existing);
    if (lastRelevantDate && new Date() < new Date(lastRelevantDate)) {
      return next(
        AppError.badRequest("This event cannot be marked Completed until its last day/date has passed"),
      );
    }

    const event = await completeEventById({
      event: existing,
      tenantId,
      actorId: userId,
      actorEmail: req.user?.email || null,
    });
    if (!event) {
      return next(AppError.conflict("This event's status changed concurrently - please retry"));
    }

    return res.status(200).json({ success: true, data: omitProductFields(event) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to complete event"));
  }
}

async function softDeleteEvent(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const existing = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!existing) return next(AppError.notFound("Event not found"));
    if (existing.status !== "Draft") {
      return next(AppError.badRequest("Only Draft events can be deleted"));
    }

    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { isDeleted: true, isActive: false, updatedBy: userId } },
      { new: true },
    );
    return res.status(200).json({ success: true, data: event });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to delete event"));
  }
}

async function addSession(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const event = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!event) return next(AppError.notFound("Event not found"));

    const {
      label,
      date,
      startTime,
      endTime,
      isVirtual,
      productId,
      productCode,
      capacity,
      memberPrice,
      nonMemberPrice,
      pricingTiers,
      joinUrl,
      organizerUpn,
    } = req.body || {};
    if (!label || !date) {
      return next(AppError.badRequest("label and date are required"));
    }

    try {
      validatePricingTiers(pricingTiers);
    } catch (validationError) {
      return next(validationError);
    }

    const session = await EventSession.create({
      tenantId,
      eventId: event._id,
      label,
      date,
      startTime,
      endTime,
      isVirtual,
      productId,
      productCode,
      capacity,
      memberPrice,
      nonMemberPrice,
      pricingTiers,
      meeting: buildMeetingField(joinUrl, organizerUpn),
      createdBy: userId,
      updatedBy: userId,
    });

    return res.status(201).json({ success: true, data: omitProductFields(session) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to add session"));
  }
}

async function updateSession(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const event = await Event.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!event) return next(AppError.notFound("Event not found"));

    const body = req.body || {};

    if (Object.prototype.hasOwnProperty.call(body, "pricingTiers")) {
      try {
        validatePricingTiers(body.pricingTiers);
      } catch (validationError) {
        return next(validationError);
      }
    }

    // Only touch `meeting` when the caller actually sent joinUrl/organizerUpn
    // - an update that doesn't mention either (e.g. just a time change) must
    // not clobber an existing meeting link/provider back to null. A joinUrl
    // rebuilds the whole sub-object (provider/externalMeetingId depend on
    // it); organizerUpn alone (added/corrected without re-pasting the link)
    // only needs a targeted dot-path $set.
    if (Object.prototype.hasOwnProperty.call(body, "joinUrl")) {
      body.meeting = buildMeetingField(body.joinUrl, body.organizerUpn);
      delete body.joinUrl;
      delete body.organizerUpn;
    } else if (Object.prototype.hasOwnProperty.call(body, "organizerUpn")) {
      body["meeting.organizerUpn"] = body.organizerUpn || null;
      delete body.organizerUpn;
    }

    // Caller is explicitly clearing this session's own price (e.g. switching
    // a multi-day event from per-day pricing back to a single event price) -
    // also drop its stale productId/productCode, if any were previously set.
    const clearingSessionPrice =
      Object.prototype.hasOwnProperty.call(body, "memberPrice") &&
      body.memberPrice == null &&
      Object.prototype.hasOwnProperty.call(body, "nonMemberPrice") &&
      body.nonMemberPrice == null;
    const updateSet = { ...body, updatedBy: userId };
    if (clearingSessionPrice) {
      updateSet.productId = null;
      updateSet.productCode = null;
      // Don't let a stale pricingTiers array survive a price clear (it would
      // make resolveAmount() treat this session as still having its own
      // pricing) - unless the caller is deliberately setting tiers in this
      // same request.
      if (!Object.prototype.hasOwnProperty.call(body, "pricingTiers")) {
        updateSet.pricingTiers = [];
      }
    }

    const session = await EventSession.findOneAndUpdate(
      {
        _id: req.params.sessionId,
        eventId: req.params.id,
        tenantId,
        isDeleted: { $ne: true },
      },
      { $set: updateSet },
      { new: true, runValidators: true },
    );
    if (!session) return next(AppError.notFound("Session not found"));

    return res.status(200).json({ success: true, data: omitProductFields(session) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to update session"));
  }
}

async function deleteSession(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const session = await EventSession.findOneAndUpdate(
      {
        _id: req.params.sessionId,
        eventId: req.params.id,
        tenantId,
        isDeleted: { $ne: true },
      },
      { $set: { isDeleted: true, isActive: false, updatedBy: userId } },
      { new: true },
    );
    if (!session) return next(AppError.notFound("Session not found"));
    return res.status(200).json({ success: true, data: omitProductFields(session) });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to delete session"));
  }
}

const sanitizeFilename = (name) =>
  (name || "image")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120) || "image";

// Event id is optional here - the image can be picked before the event is
// first saved (create flow), so an unsaved event uploads under "draft" and
// the resulting URL rides along in the create payload like any other field.
async function uploadEventImage(req, res, next) {
  try {
    const { tenantId } = req.ctx;

    if (!req.file?.buffer) {
      return next(AppError.badRequest("Image file is required"));
    }
    if (!azureBlob.isConfigured) {
      return next(
        AppError.internalServerError(
          "Azure Storage is not configured. Set AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY.",
        ),
      );
    }

    const eventKey = req.params.id && req.params.id !== "draft" ? req.params.id : "draft";
    const ext = req.file.originalname?.split(".").pop()?.toLowerCase() || "png";
    const safeExt = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext) ? ext : "png";
    const blobPath = `${tenantId}/${eventKey}-${crypto.randomUUID()}.${safeExt}`;

    await azureBlob.uploadToBlob(
      blobPath,
      req.file.buffer,
      req.file.mimetype,
      sanitizeFilename(req.file.originalname),
    );
    // The storage account has anonymous public access disabled, so the bare
    // blob URL 404s in a browser <img> tag - hand back a long-lived SAS URL
    // instead, which is what actually gets persisted as Event.imageUrl.
    const url = azureBlob.getLongLivedReadUrl(blobPath);

    return res.status(200).json({ success: true, data: { url } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to upload event image"));
  }
}

module.exports = {
  listEvents,
  getEventById,
  getEventPriceQuote,
  createEvent,
  updateEvent,
  unpublishEvent,
  cancelEvent,
  completeEvent,
  completeEventById,
  getLastRelevantDate,
  softDeleteEvent,
  addSession,
  updateSession,
  deleteSession,
  uploadEventImage,
};
