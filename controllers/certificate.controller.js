const Registration = require("../models/registration.model.js");
const Certificate = require("../models/certificate.model.js");
const { AppError } = require("../errors/AppError.js");
const { generateCertificateLetter } = require("../services/communicationService.client.js");
const { publishCertificateIssued } = require("../rabbitMQ/publishers/registration.events.publisher.js");

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

    const letter = await generateCertificateLetter({
      authHeaders: extractAuthHeaders(req),
      profileId: registration.profileId,
      templateId,
      registrationId: String(registration._id),
    });

    const certificate = await Certificate.create({
      tenantId,
      registrationId: registration._id,
      profileId: registration.profileId,
      issuedAt: new Date(),
      generatedLetterId: letter?.letterId || letter?._id || null,
      status: "issued",
      createdBy: userId,
    });

    await publishCertificateIssued(certificate, registration, tenantId);

    return res.status(201).json({ success: true, data: certificate });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(AppError.internalServerError(error.message || "Failed to issue certificate"));
  }
}

module.exports = { issueCertificate };
