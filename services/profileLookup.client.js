const axios = require("axios");

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/profile-service";

/**
 * Find or create a Profile for an event/course attendee, with no membership
 * number, via profile-service's internal endpoint. Used for both portal and
 * CRM registrations - neither ever creates a membership application.
 */
async function findOrCreateAttendeeProfile({
  tenantId,
  email,
  firstName,
  lastName,
  phone,
}) {
  const response = await axios.post(
    `${PROFILE_SERVICE_URL}/api/profile/internal/find-or-create-attendee`,
    { tenantId, email, firstName, lastName, phone },
    {
      headers: {
        "Content-Type": "application/json",
        "x-internal-request": "true",
        "x-tenant-id": tenantId || "",
      },
      timeout: 15000,
    },
  );
  return response.data?.data;
}

module.exports = { findOrCreateAttendeeProfile };
