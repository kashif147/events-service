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
const { determinePriceCategory, resolveAmount } = require("../services/pricingResolution.service.js");
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

    const seatQuantity = quantity != null ? Number(quantity) : 1;
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
      });
      profileId = resolved.profileId;
      membershipNumber = resolved.membershipNumber;
    }

    // 3. Determine real (verified) membership status/category - never trust a
    // client-supplied member/price-category flag. A profile with a
    // membershipNumber but a lapsed/cancelled subscription still prices as a
    // non-member.
    const { isActiveMember, membershipCategory } = await getActiveMembership({
      profileId,
      tenantId,
      req,
    });
    const seatPriceCategory = event
      ? determinePriceCategory({
          isActiveMember,
          membershipCategory,
          quantity: seatQuantity,
          entity: event,
        })
      : "standard";

    // 4. Price the registration.
    const { amount, currency, productCode, eventCategoryCode } = await resolveAmount({
      tenantId,
      registrationType,
      eventId,
      courseId,
      sessionIds,
      isMember: isActiveMember,
      priceCategory: seatPriceCategory,
      quantity: seatQuantity,
    });

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
    return next(AppError.internalServerError(error.message || "Failed to create registration"));
  }
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

    const registrations = await Registration.find(filter).sort({ createdAt: -1 }).limit(20).lean();
    return res.status(200).json({ success: true, data: registrations });
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
    const { email, firstName, lastName, phone } = req.body || {};
    if (!email) return next(AppError.badRequest("email is required"));

    const result = await checkAttendeeDuplicates({ tenantId, email, firstName, lastName, phone });
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
