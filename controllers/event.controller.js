const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const { AppError } = require("../errors/AppError.js");
const { ensureEventProductLink, syncEventProductLink } = require("../services/eventProductLink.service.js");
const bizLogger = require("../config/bizLogger.js");

const PRODUCT_SYNC_TRIGGER_FIELDS = [
  "memberPrice",
  "nonMemberPrice",
  "startDate",
  "endDate",
  "eventCategoryCode",
  "eventCategoryProductTypeId",
  "description",
];

const PUBLISHED_LOCKED_STATUS_TARGETS = ["Cancelled", "Completed"];

// Logging must never be able to turn a "the event saved fine, just the
// optional Product/Pricing link failed" outcome into a false 500 - a broken
// logger call previously escaped its catch block and did exactly that.
function safeLogError(message, meta) {
  try {
    bizLogger.error(message, meta);
  } catch (_loggingError) {
    // Swallow - logging failures must never affect the response.
  }
}

// Axios errors' own .message is a generic "Request failed with status code
// 400" - the useful reason is nested in the downstream service's AppError
// response envelope. Surface that instead so the warning is self-diagnosable
// without needing server log access.
function extractLinkErrorMessage(error) {
  return error?.response?.data?.error?.message || error?.message || "Unknown error";
}

async function listEvents(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { status, from, to, q } = req.query;

    const filter = { tenantId, isDeleted: { $ne: true } };
    if (status) filter.status = status;
    if (from || to) {
      filter.startDate = {};
      if (from) filter.startDate.$gte = new Date(from);
      if (to) filter.startDate.$lte = new Date(to);
    }
    if (q) filter.title = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const events = await Event.find(filter).sort({ startDate: 1 }).lean();
    return res.status(200).json({ success: true, data: events });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list events"));
  }
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

    return res.status(200).json({ success: true, data: { ...event, sessions } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch event"));
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
      eventTypeId,
      memberPrice,
      nonMemberPrice,
      venueId,
      venue,
      isVirtual,
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
    } = req.body || {};

    if (!title || !startDate || !endDate) {
      return next(AppError.badRequest("title, startDate and endDate are required"));
    }
    if (!eventCategoryProductTypeId) {
      return next(AppError.badRequest("eventCategoryProductTypeId is required"));
    }
    if (!venueId) {
      return next(AppError.badRequest("venueId is required"));
    }
    if (!description || !String(description).replace(/<[^>]*>/g, "").trim()) {
      return next(AppError.badRequest("description is required"));
    }

    let event = await Event.create({
      tenantId,
      title,
      description,
      productId,
      productCode,
      eventCategoryCode,
      eventCategoryProductTypeId,
      eventTypeId,
      memberPrice,
      nonMemberPrice,
      venueId,
      venue,
      isVirtual,
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
      createdBy: userId,
      createdByEmail: req.user?.email || null,
      updatedBy: userId,
      updatedByEmail: req.user?.email || null,
    });

    let warning;
    if (eventCategoryProductTypeId && memberPrice != null && nonMemberPrice != null) {
      try {
        const link = await ensureEventProductLink(event, req, tenantId);
        event = await Event.findByIdAndUpdate(event._id, { $set: link }, { new: true });
      } catch (linkError) {
        const reason = extractLinkErrorMessage(linkError);
        safeLogError("Failed to auto-link Product/Pricing for new event", {
          eventId: event._id,
          error: reason,
        });
        warning = `Product/pricing link failed: ${reason} — link manually in Product Management`;
      }
    }

    return res.status(201).json({ success: true, data: event, ...(warning ? { warning } : {}) });
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

    let event = await Event.findOneAndUpdate(
      { _id: req.params.id, tenantId, isDeleted: { $ne: true } },
      { $set: { ...body, updatedBy: userId, updatedByEmail: req.user?.email || null } },
      { new: true, runValidators: true },
    );
    if (!event) return next(AppError.notFound("Event not found"));

    let warning;
    const shouldSyncProduct = PRODUCT_SYNC_TRIGGER_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(body, field),
    );
    if (shouldSyncProduct && event.eventCategoryProductTypeId && event.memberPrice != null && event.nonMemberPrice != null) {
      try {
        if (!event.productId) {
          const link = await ensureEventProductLink(event, req, tenantId);
          event = await Event.findByIdAndUpdate(event._id, { $set: link }, { new: true });
        } else {
          await syncEventProductLink(event, req, tenantId);
        }
      } catch (linkError) {
        const reason = extractLinkErrorMessage(linkError);
        safeLogError("Failed to sync Product/Pricing for updated event", {
          eventId: event._id,
          error: reason,
        });
        warning = `Product/pricing sync failed: ${reason} — update manually in Product Management`;
      }
    }

    return res.status(200).json({ success: true, data: event, ...(warning ? { warning } : {}) });
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

    const { label, date, productId, productCode, capacity } = req.body || {};
    if (!label || !date) {
      return next(AppError.badRequest("label and date are required"));
    }

    const session = await EventSession.create({
      tenantId,
      eventId: event._id,
      label,
      date,
      productId,
      productCode,
      capacity,
      createdBy: userId,
      updatedBy: userId,
    });

    return res.status(201).json({ success: true, data: session });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to add session"));
  }
}

async function updateSession(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const session = await EventSession.findOneAndUpdate(
      {
        _id: req.params.sessionId,
        eventId: req.params.id,
        tenantId,
        isDeleted: { $ne: true },
      },
      { $set: { ...req.body, updatedBy: userId } },
      { new: true, runValidators: true },
    );
    if (!session) return next(AppError.notFound("Session not found"));
    return res.status(200).json({ success: true, data: session });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to update session"));
  }
}

module.exports = {
  listEvents,
  getEventById,
  createEvent,
  updateEvent,
  softDeleteEvent,
  addSession,
  updateSession,
};
