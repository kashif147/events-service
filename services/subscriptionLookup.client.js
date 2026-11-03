const axios = require("axios");
const { AppError } = require("../errors/AppError.js");

// P5: no hard-coded fallback host. A missing SUBSCRIPTION_SERVICE_URL is a configuration error and fails
// closed (503) before any request - never an internal-header call to an unintended (public) host.
function subscriptionServiceBase() {
  const raw = process.env.SUBSCRIPTION_SERVICE_URL;
  const base = raw == null ? "" : String(raw).trim().replace(/\/+$/, "");
  if (!base) {
    throw new AppError(
      "Membership lookup is not configured",
      503,
      "SUBSCRIPTION_SERVICE_URL_REQUIRED",
    );
  }
  return base;
}

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

const ACTIVE_STATUS = "Active";

function validDate(v) {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * P5: subscription-service GET /subscriptions/profile/:id/current answers
 *   200 { status: "success", data: { data: <current ACTIVE subscription | null> } }
 * (res.success({ data: sub }) wraps once more). A 200 is never membership by itself: the client
 * re-checks the documented rule (subscription-service models/subscription.model.js +
 * controllers/subscription.controller.js getSubscriptionsByProfile: one `isCurrent: true` row per
 * {tenantId, profileId}, `subscriptionStatus` "Active"; endDate = end of the membership year) on the
 * returned object itself. Membership needs ALL of: this profile, this tenant (present and equal),
 * isCurrent === true, subscriptionStatus === "Active", and a valid endDate not in the past. Anything
 * else - null, an array, the outer wrapper, a missing/other tenant or profile, a missing status or
 * endDate, an expired or non-Active row - is "not a member" (fail closed). Exported for tests.
 */
function parseCurrentSubscription(body, { profileId, tenantId, now = new Date() }) {
  if (!body || typeof body !== "object" || body.status !== "success") return null;
  const outer = body.data;
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return null;
  const sub = outer.data;
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null;
  if (sub.profileId == null || String(sub.profileId) !== String(profileId)) return null;
  if (sub.tenantId == null || String(sub.tenantId) !== String(tenantId)) return null;
  if (sub.isCurrent !== true) return null;
  if (sub.subscriptionStatus !== ACTIVE_STATUS) return null;
  const endDate = validDate(sub.endDate);
  if (!endDate || endDate.getTime() < now.getTime()) return null;
  return sub;
}

/**
 * Whether a profile currently has an ACTIVE subscription (isCurrent + status
 * "Active"), and its membershipCategory if so. Any other state - lapsed,
 * cancelled, resigned, or no subscription at all - resolves to non-member.
 */
async function getActiveMembership({ profileId, tenantId }) {
  if (!profileId) return { isActiveMember: false, membershipCategory: null };
  // Internal calls must carry the trusted tenant; subscription-service refuses
  // them otherwise (400 TENANT_REQUIRED), so do not send one without it.
  const trustedTenant = tenantId == null ? "" : String(tenantId).trim();
  if (!trustedTenant) return { isActiveMember: false, membershipCategory: null };

  const base = subscriptionServiceBase();
  try {
    const response = await axios.get(
      `${base}/api/v1/subscriptions/profile/${profileId}/current`,
      { headers: buildHeaders(trustedTenant), timeout: 15000 },
    );
    const subscription = parseCurrentSubscription(response.data, {
      profileId,
      tenantId: trustedTenant,
    });
    return {
      isActiveMember: !!subscription,
      membershipCategory: subscription?.membershipCategory || null,
    };
  } catch (error) {
    console.error("[subscriptionLookup] getActiveMembership failed:", error.message);
    return { isActiveMember: false, membershipCategory: null };
  }
}

module.exports = { getActiveMembership, buildHeaders, parseCurrentSubscription };
