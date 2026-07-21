const mongoose = require("mongoose");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Course = require("../models/course.model.js");
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const { findOrCreateAttendeeProfile } = require("../services/profileLookup.client.js");
const { getCurrentPriceForProduct } = require("../services/pricing.client.js");
const {
  createRegistrationPaymentIntent,
  postManualRegistrationPayment,
} = require("../services/accountService.client.js");
const {
  publishRegistrationCreated,
  publishRegistrationConfirmed,
  publishRegistrationCancelled,
} = require("../rabbitMQ/publishers/registration.events.publisher.js");

/**
 * Resolve the per-person price (in euros) for a single Event or EventSession
 * document - both share the memberPrice/nonMemberPrice/pricingTiers shape.
 * Throws AppError.badRequest if the requested priceCategory isn't available
 * on the entity, or (for group_student) if quantity doesn't meet the
 * minimum group size.
 */
function resolveUnitPriceForEntity({ entity, entityLabel, isMember, priceCategory, quantity, now }) {
  const tiers = Array.isArray(entity.pricingTiers) ? entity.pricingTiers : [];
  const activeTierOfType = (tierType) =>
    tiers.find((t) => t.tierType === tierType && t.isActive !== false);

  if (priceCategory === "student") {
    const tier = activeTierOfType("STUDENT");
    if (!tier) throw AppError.badRequest(`Student pricing is not available for ${entityLabel}`);
    return tier.price;
  }

  if (priceCategory === "group_student") {
    const tier = activeTierOfType("GROUP_STUDENT");
    if (!tier) throw AppError.badRequest(`Group student pricing is not available for ${entityLabel}`);
    const minSize = tier.minGroupSize || 2;
    if (quantity < minSize) {
      throw AppError.badRequest(
        `Group student pricing for ${entityLabel} requires at least ${minSize} seat(s) in this registration (you have ${quantity})`,
      );
    }
    return tier.price; // per-person - caller multiplies by quantity
  }

  // "standard": early bird (if within cutoff) else the base price.
  const earlyBirdType = isMember ? "EARLY_BIRD_MEMBER" : "EARLY_BIRD_NON_MEMBER";
  const earlyBird = activeTierOfType(earlyBirdType);
  if (earlyBird && earlyBird.cutoffDate && now <= new Date(earlyBird.cutoffDate)) {
    return earlyBird.price;
  }
  return (isMember ? entity.memberPrice : entity.nonMemberPrice) || 0;
}

async function resolveAmount({
  tenantId,
  registrationType,
  eventId,
  courseId,
  sessionIds,
  isMember,
  priceCategory = "standard",
  quantity = 1,
}) {
  if (registrationType === "course") {
    const course = await Course.findOne({ _id: courseId, tenantId }).lean();
    if (!course) throw AppError.notFound("Course not found");
    const { amount, currency } = await getCurrentPriceForProduct(course.productId, { isMember });
    // Courses have no Event Category equivalent yet - account-service falls
    // back to its default GL income code when eventCategoryCode is null.
    return { amount: amount * quantity, currency, productCode: course.productCode || null, eventCategoryCode: null };
  }

  const event = await Event.findOne({ _id: eventId, tenantId }).lean();
  if (!event) throw AppError.notFound("Event not found");
  const now = new Date();

  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    const sessions = await EventSession.find({
      _id: { $in: sessionIds },
      tenantId,
      eventId,
    }).lean();
    let amount = 0;
    for (const session of sessions) {
      // A session with no price/tiers of its own (per-day pricing off, or
      // this particular day left at the event's default) prices at the
      // event's own rate instead of silently coming out as 0.
      const hasOwnPricing =
        session.memberPrice != null ||
        session.nonMemberPrice != null ||
        (Array.isArray(session.pricingTiers) && session.pricingTiers.length > 0);
      const priceEntity = hasOwnPricing ? session : event;
      const unitPriceEuros = resolveUnitPriceForEntity({
        entity: priceEntity,
        entityLabel: session.label || event.title,
        isMember,
        priceCategory,
        quantity,
        now,
      });
      amount += Math.round(unitPriceEuros * 100);
    }
    return {
      amount: amount * quantity,
      currency: "eur",
      productCode: event.productCode || null,
      eventCategoryCode: event.eventCategoryLookupCode || null,
    };
  }

  const unitPriceEuros = resolveUnitPriceForEntity({
    entity: event,
    entityLabel: event.title,
    isMember,
    priceCategory,
    quantity,
    now,
  });
  return {
    amount: Math.round(unitPriceEuros * 100) * quantity,
    currency: "eur",
    productCode: event.productCode || null,
    eventCategoryCode: event.eventCategoryLookupCode || null,
  };
}

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
      priceCategory,
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

    const seatPriceCategory = priceCategory || "standard";
    if (!["standard", "student", "group_student"].includes(seatPriceCategory)) {
      return next(AppError.badRequest("priceCategory must be 'standard', 'student' or 'group_student'"));
    }

    // 1. Enforce seat capacity, if the event/session(s) declare one, before
    // doing anything else (fail fast rather than creating an attendee
    // Profile only to reject the booking).
    if (registrationType === "event") {
      const event = await Event.findOne({ _id: eventId, tenantId }).lean();
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
    const isMember = !!membershipNumber;

    // 3. Price the registration.
    const { amount, currency, productCode, eventCategoryCode } = await resolveAmount({
      tenantId,
      registrationType,
      eventId,
      courseId,
      sessionIds,
      isMember,
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
      isMemberAtRegistration: isMember,
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

    // 4. Take payment.
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

module.exports = {
  createRegistration,
  listRegistrations,
  getRegistrationsByProfile,
  cancelRegistration,
};
