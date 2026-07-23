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
  workLocation,
  grade,
  addressLine1,
  addressLine2,
  townCity,
  countyState,
  eircode,
  country,
}) {
  const response = await axios.post(
    `${PROFILE_SERVICE_URL}/api/profile/internal/find-or-create-attendee`,
    {
      tenantId,
      email,
      firstName,
      lastName,
      phone,
      workLocation,
      grade,
      addressLine1,
      addressLine2,
      townCity,
      countyState,
      eircode,
      country,
    },
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

/**
 * Read-only duplicate check for a would-be new attendee, run before
 * registering them - never creates a Profile. See profile-service's
 * attendeeProfileLookup.helper.js's checkAttendeeDuplicates for the
 * exact/review/none resolution semantics.
 */
async function checkAttendeeDuplicates({
  tenantId,
  email,
  firstName,
  lastName,
  phone,
  addressLine1,
  townCity,
  countyState,
  eircode,
  country,
}) {
  const response = await axios.post(
    `${PROFILE_SERVICE_URL}/api/profile/internal/attendee-duplicate-check`,
    { tenantId, email, firstName, lastName, phone, addressLine1, townCity, countyState, eircode, country },
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

module.exports = { findOrCreateAttendeeProfile, checkAttendeeDuplicates };
