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

async function resolveAmount({ tenantId, registrationType, eventId, courseId, sessionIds, isMember }) {
  if (registrationType === "course") {
    const course = await Course.findOne({ _id: courseId, tenantId }).lean();
    if (!course) throw AppError.notFound("Course not found");
    const { amount, currency } = await getCurrentPriceForProduct(course.productId, { isMember });
    return { amount, currency, productCode: course.productCode || null };
  }

  const event = await Event.findOne({ _id: eventId, tenantId }).lean();
  if (!event) throw AppError.notFound("Event not found");

  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    const sessions = await EventSession.find({
      _id: { $in: sessionIds },
      tenantId,
      eventId,
    }).lean();
    let amount = 0;
    let currency = "eur";
    for (const session of sessions) {
      const priced = await getCurrentPriceForProduct(session.productId, { isMember });
      amount += priced.amount || 0;
      currency = priced.currency || currency;
    }
    return { amount, currency, productCode: event.productCode || null };
  }

  const { amount, currency } = await getCurrentPriceForProduct(event.productId, { isMember });
  return { amount, currency, productCode: event.productCode || null };
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

    // 1. Resolve (or create) the attendee's Profile - never enters the
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

    // 2. Price the registration.
    const { amount, currency, productCode } = await resolveAmount({
      tenantId,
      registrationType,
      eventId,
      courseId,
      sessionIds,
      isMember,
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

    // 3. Take payment.
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
