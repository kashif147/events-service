const axios = require("axios");

const COMMUNICATION_SERVICE_URL =
  process.env.COMMUNICATION_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/communication-service";

/**
 * Generate a certificate letter via communication-service's existing
 * /api/letters/generate endpoint, reusing its template/PDF pipeline rather
 * than building a new one. Forwards the caller's own gateway-verified auth
 * headers through, since /generate is authenticated per-user (not an
 * internal-request bypass) and the caller (CRM staff, or the system acting on
 * their behalf) already has a valid context for this profile/tenant.
 */
async function generateCertificateLetter({ authHeaders, profileId, templateId, registrationId }) {
  const response = await axios.post(
    `${COMMUNICATION_SERVICE_URL}/api/letters/generate`,
    { memberId: profileId, templateId, registrationId },
    { headers: { "Content-Type": "application/json", ...authHeaders }, timeout: 30000 },
  );
  return response.data?.data;
}

module.exports = { generateCertificateLetter };
