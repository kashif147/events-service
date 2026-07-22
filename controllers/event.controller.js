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

const PUBLISHED_LOCKED_STATUS_TARGETS = ["Cancelled", "Completed"];

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
// data, mirroring how eventCategoryProductTypeId's code is derived elsewhere.
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
    if (eventCategoryCode) filter.eventCategoryCode = eventCategoryCode;
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
      eventCategoryCode,
      eventCategoryProductTypeId,
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
      eventCategoryCode,
      eventCategoryProductTypeId,
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
      const disallowedKey = Object.keys(body).find(
        (key) => key !== "status" && key !== "isActive" && key !== "description",
      );
      if (disallowedKey) {
        return next(
          AppError.badRequest("Published events can only have their status or active flag changed"),
        );
      }
      if (body.status && !PUBLISHED_LOCKED_STATUS_TARGETS.includes(body.status)) {
        return next(
          AppError.badRequest(`Published events can only move to: ${PUBLISHED_LOCKED_STATUS_TARGETS.join(", ")}`),
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
  softDeleteEvent,
  addSession,
  updateSession,
  deleteSession,
  uploadEventImage,
};
