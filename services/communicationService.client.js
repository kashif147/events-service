const axios = require("axios");

const COMMUNICATION_SERVICE_URL =
  process.env.COMMUNICATION_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/communication-service";

/**
 * Generate a certificate letter via communication-service's existing
 * /api/letters/generate endpoint, reusing its template/PDF pipeline rather
 * than building a new one. Forwards the caller's own gateway-verified auth
 * headers through, since /generate is authenticated per-user (not an
 * internal-request bypass) and the caller (CRM staff) already has a valid
 * context for this profile/tenant. Manual (CRM-triggered) issuance only.
 * `mergeFields` (EventTitle/EventDate/CpdCredits/etc. - see
 * certificateIssuance.service.js) are merged into the docx template
 * alongside member data communication-service resolves itself.
 */
async function generateCertificateLetter({ authHeaders, profileId, templateId, registrationId, mergeFields }) {
  const response = await axios.post(
    `${COMMUNICATION_SERVICE_URL}/api/letters/generate`,
    { memberId: profileId, templateId, registrationId, mergeFields },
    { headers: { "Content-Type": "application/json", ...authHeaders }, timeout: 30000 },
  );
  return response.data?.data;
}

/**
 * Same letter-generation pipeline, for automatic certificate issuance (the
 * completion sweep job - see services/autoCertificate.service.js) - there is
 * no originating user/request to forward gateway headers from, so this calls
 * communication-service's internal (x-internal-request) letters endpoint
 * instead, the same pattern correspondence.controller.js's requireInternal()
 * routes already use there. `deliver` optionally asks communication-service
 * to also email the generated document.
 */
async function generateCertificateLetterInternal({
  tenantId,
  profileId,
  templateId,
  registrationId,
  deliver,
  mergeFields,
}) {
  const response = await axios.post(
    `${COMMUNICATION_SERVICE_URL}/api/letters/internal/generate`,
    { memberId: profileId, templateId, registrationId, deliver, mergeFields },
    {
      headers: { "Content-Type": "application/json", "x-internal-request": "true", "x-tenant-id": tenantId },
      timeout: 30000,
    },
  );
  return response.data?.data;
}

module.exports = { generateCertificateLetter, generateCertificateLetterInternal };
