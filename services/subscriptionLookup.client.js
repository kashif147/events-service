const axios = require("axios");
const { AppError } = require("../errors/AppError.js");

const SUBSCRIPTION_SERVICE_URL =
  process.env.SUBSCRIPTION_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/subscription-service";

// P5 (subscription #30 prerequisite): this lookup is a service-to-service read
// made AFTER events-service has authorized the business action (registration
// create / price quote) and resolved the profileId server-side. It is sent as a
// genuine internal call - x-internal-request + the caller's VERIFIED tenant -
// and never carries the caller's identity (Authorization / x-jwt-verified /
// x-auth-source / x-user-*). Mixing both made subscription-service treat a user
// request as internal; once internal stops accepting a forwarded identity, a
// mixed request would instead be evaluated as the user (non-ASU CRM is denied
// subscriptions:read by the PDP category rule), silently pricing members as
// non-members.
function buildHeaders(tenantId) {
  return {
    "Content-Type": "application/json",
    "x-internal-request": "true",
    "x-tenant-id": tenantId,
  };
}

/**
 * Whether a profile currently has an ACTIVE subscription (isCurrent + status
 * "Active"), and its membershipCategory if so. Any other state - lapsed,
 * cancelled, resigned, or no subscription at all - resolves to non-member.
 * A FAILED lookup (network error, timeout, non-2xx) is never treated as
 * non-member: it throws a 503 MEMBERSHIP_LOOKUP_FAILED so no registration is
 * priced or created on an unknown membership state (P5 STUDENT policy).
 */
async function getActiveMembership({ profileId, tenantId }) {
  if (!profileId) return { isActiveMember: false, membershipCategory: null };
  // Internal calls must carry the trusted tenant; subscription-service refuses
  // them otherwise (400 TENANT_REQUIRED), so do not send one without it.
  const trustedTenant = tenantId == null ? "" : String(tenantId).trim();
  if (!trustedTenant) return { isActiveMember: false, membershipCategory: null };

  const base = SUBSCRIPTION_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(
      `${base}/api/v1/subscriptions/profile/${profileId}/current`,
      { headers: buildHeaders(trustedTenant), timeout: 15000 },
    );
    const subscription = response.data?.data || null;
    return {
      isActiveMember: !!subscription,
      membershipCategory: subscription?.membershipCategory || null,
    };
  } catch (error) {
    console.error("[subscriptionLookup] getActiveMembership failed:", error.message);
    throw new AppError(
      "Unable to verify membership right now. Please try again.",
      503,
      "MEMBERSHIP_LOOKUP_FAILED",
    );
  }
}

module.exports = { getActiveMembership, buildHeaders };
