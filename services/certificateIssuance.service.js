// Core certificate-issuance logic, shared by the manual CRM route
// (controllers/certificate.controller.js's issueCertificate, real
// authHeaders forwarded from the CRM user's own request) and automatic
// issuance on event completion (services/autoCertificate.service.js, no
// originating request - see generateCertificateLetterInternal below).
const Certificate = require("../models/certificate.model.js");
const {
  generateCertificateLetter,
  generateCertificateLetterInternal,
} = require("../services/communicationService.client.js");
const { publishCertificateIssued } = require("../rabbitMQ/publishers/registration.events.publisher.js");
const { AppError } = require("../errors/AppError.js");

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string|null} params.actorId - userId for the manual path, null for auto-issuance
 * @param {object} params.registration - Registration doc (must have a resolved profileId)
 * @param {object} params.event - Event doc, for the extended certificate.issued.v1 payload
 * @param {string} params.templateId - communication-service Template id
 * @param {object|null} params.authHeaders - forwarded gateway headers (manual path only) -
 *   null triggers the internal (system-to-system) communication-service call instead.
 * @param {{email?: boolean, toAddress?: string}} [params.deliver] - only meaningful on the
 *   internal path; the manual/authenticated path never auto-emails (a CRM user driving this
 *   endpoint gets the same download-URL response it always has).
 */
// Event-specific placeholders the certificate docx template can reference -
// collectMemberData (communication-service) only ever resolves profile/
// subscription/account fields, it has no idea what event this certificate is
// for, so this is the only way that information reaches the template.
function buildCertificateMergeFields(event) {
  if (!event) return {};
  return {
    EventTitle: event.title || "",
    EventDate: event.startDate ? new Date(event.startDate).toDateString() : "",
    CpdCredits: event.cpdCredits ?? "",
    AccreditationBody: event.accreditationBody || "",
    CertificationType: event.certificationType || "",
  };
}

async function createCertificateForRegistration({
  tenantId,
  actorId,
  registration,
  event,
  templateId,
  authHeaders,
  deliver,
}) {
  if (!registration.profileId) {
    throw AppError.badRequest("Certificate cannot be issued for a registration with no linked profile");
  }

  const mergeFields = buildCertificateMergeFields(event);

  const letter = authHeaders
    ? await generateCertificateLetter({
        authHeaders,
        profileId: registration.profileId,
        templateId,
        registrationId: String(registration._id),
        mergeFields,
      })
    : await generateCertificateLetterInternal({
        tenantId,
        profileId: registration.profileId,
        templateId,
        registrationId: String(registration._id),
        // toAddress comes from the registration itself (the attendee's own
        // email at signup) rather than asking communication-service to
        // re-derive it from the Profile - it already has this, no extra
        // cross-service round trip needed.
        deliver: deliver?.email ? { ...deliver, toAddress: registration.attendeeSnapshot?.email } : deliver,
        mergeFields,
      });

  const certificate = await Certificate.create({
    tenantId,
    registrationId: registration._id,
    profileId: registration.profileId,
    issuedAt: new Date(),
    generatedLetterId: letter?.letterId || letter?._id || null,
    status: "issued",
    createdBy: actorId || null,
  });

  await publishCertificateIssued(certificate, registration, tenantId, event);

  return certificate;
}

module.exports = { createCertificateForRegistration };
