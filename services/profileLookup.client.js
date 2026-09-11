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
  title,
  firstName,
  lastName,
  gender,
  dateOfBirth,
  phone,
  workLocation,
  grade,
  nmbiNumber,
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
      title,
      firstName,
      lastName,
      gender,
      dateOfBirth,
      phone,
      workLocation,
      grade,
      nmbiNumber,
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
  nmbiNumber,
  dateOfBirth,
  addressLine1,
  townCity,
  countyState,
  eircode,
  country,
}) {
  const response = await axios.post(
    `${PROFILE_SERVICE_URL}/api/profile/internal/attendee-duplicate-check`,
    {
      tenantId,
      email,
      firstName,
      lastName,
      phone,
      nmbiNumber,
      dateOfBirth,
      addressLine1,
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
 * Resolve the real membershipNumber for an already-known Profile
 * (profile.profileId supplied by the caller - CRM CreateAttendeeDrawer or
 * portal self-service), via profile-service's batch endpoint, rather than
 * trusting any caller-supplied membership number. Used when profileId IS
 * supplied to createRegistration, so Registration.membershipNumber is never
 * silently left null for existing members.
 */
async function getProfileMembershipNumber({ tenantId, profileId }) {
  if (!profileId) return null;
  try {
    const response = await axios.post(
      `${PROFILE_SERVICE_URL}/api/profile/batch`,
      { profileIds: [profileId] },
      {
        headers: {
          "Content-Type": "application/json",
          "x-internal-request": "true",
          "x-tenant-id": tenantId || "",
        },
        timeout: 15000,
      },
    );
    const profiles = response.data?.data || [];
    return profiles[0]?.membershipNumber || null;
  } catch (error) {
    console.error("[profileLookup] getProfileMembershipNumber failed:", error.message);
    return null;
  }
}

/**
 * Best-effort fill-in of blank professionalDetails.nmbiNumber / personalInfo.
 * title,gender,dateOfBirth on an already-resolved Profile (profile.profileId
 * supplied by the caller - the CRM "search and select an existing profile"
 * path, or a registration whose email exactly matched an existing profile -
 * both never go through findOrCreateAttendeeProfile's own by-email backfill
 * since they already have a profileId). Swallows its own errors like
 * getProfileMembershipNumber above, so a sync hiccup never blocks
 * registration - never overwrites a value the profile already has.
 */
async function syncAttendeeProfileFields({ tenantId, profileId, nmbiNumber, title, gender, dateOfBirth }) {
  if (!nmbiNumber && !title && !gender && !dateOfBirth) return null;
  try {
    const response = await axios.post(
      `${PROFILE_SERVICE_URL}/api/profile/internal/attendee-profile-fields-sync`,
      { tenantId, profileId, nmbiNumber, title, gender, dateOfBirth },
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
  } catch (error) {
    console.error("[profileLookup] syncAttendeeProfileFields failed:", error.message);
    return null;
  }
}

/**
 * Real (overwrite, not blank-only) edit of an already-linked attendee
 * Profile's personalInfo/contactInfo/professionalDetails - used when a CRM
 * user edits an existing registration's attendee details. Unlike
 * syncAttendeeProfileFields/deleteAttendeeProfile above, this does NOT
 * swallow its own errors - the caller (updateRegistrationAttendee) needs to
 * know whether the profile side actually succeeded so it can tell the CRM
 * user, rather than silently leaving the Registration and Profile out of
 * sync with no indication anything went wrong.
 */
async function updateAttendeeProfileFields({
  tenantId,
  profileId,
  title,
  firstName,
  lastName,
  gender,
  dateOfBirth,
  email,
  phone,
  workLocation,
  grade,
  nmbiNumber,
  addressLine1,
  addressLine2,
  townCity,
  countyState,
  eircode,
  country,
}) {
  const response = await axios.post(
    `${PROFILE_SERVICE_URL}/api/profile/internal/attendee-profile-fields-update`,
    {
      tenantId,
      profileId,
      title,
      firstName,
      lastName,
      gender,
      dateOfBirth,
      email,
      phone,
      workLocation,
      grade,
      nmbiNumber,
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
 * Compensating rollback for a Profile findOrCreateAttendeeProfile just
 * created in THIS SAME registration attempt, called when a later step (e.g.
 * payment intent creation) fails - so the failed attempt never leaves a
 * half-created Profile behind. Best-effort: swallows its own errors so a
 * rollback failure never masks the original error being surfaced to the CRM.
 */
async function deleteAttendeeProfile({ tenantId, profileId }) {
  try {
    const response = await axios.post(
      `${PROFILE_SERVICE_URL}/api/profile/internal/rollback-attendee-profile`,
      { tenantId, profileId },
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
  } catch (error) {
    console.error("[profileLookup] deleteAttendeeProfile (rollback) failed:", error.message);
    return { deleted: false, reason: "request_failed" };
  }
}

module.exports = {
  findOrCreateAttendeeProfile,
  checkAttendeeDuplicates,
  getProfileMembershipNumber,
  syncAttendeeProfileFields,
  updateAttendeeProfileFields,
  deleteAttendeeProfile,
};
