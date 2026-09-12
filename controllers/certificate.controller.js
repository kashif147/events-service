const Registration = require("../models/registration.model.js");
const Event = require("../models/event.model.js");
const { AppError } = require("../errors/AppError.js");
const { createCertificateForRegistration } = require("../services/certificateIssuance.service.js");

const FORWARDED_AUTH_HEADERS = [
  "authorization",
  "x-jwt-verified",
  "x-auth-source",
  "x-user-id",
  "x-tenant-id",
  "x-user-email",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
  "x-gateway-signature",
];

function extractAuthHeaders(req) {
  const headers = {};
  for (const name of FORWARDED_AUTH_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  return headers;
}

async function issueCertificate(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const { templateId } = req.body || {};
    if (!templateId) return next(AppError.badRequest("templateId is required"));

    const registration = await Registration.findOne({
      _id: req.params.registrationId,
      tenantId,
      isDeleted: { $ne: true },
    });
    if (!registration) return next(AppError.notFound("Registration not found"));

    const event = registration.eventId
      ? await Event.findOne({ _id: registration.eventId, tenantId }).lean()
      : null;

    const certificate = await createCertificateForRegistration({
      tenantId,
      actorId: userId,
      registration,
      event,
      templateId,
      authHeaders: extractAuthHeaders(req),
    });

    return res.status(201).json({ success: true, data: certificate });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to issue certificate"));
  }
}

module.exports = { issueCertificate };
