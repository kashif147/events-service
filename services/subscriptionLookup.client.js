const axios = require("axios");

const SUBSCRIPTION_SERVICE_URL =
  process.env.SUBSCRIPTION_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/subscription-service";

function buildHeaders(req, tenantId) {
  const headers = {
    "Content-Type": "application/json",
    "x-internal-request": "true",
    "x-tenant-id": tenantId || "",
  };
  if (req?.headers?.authorization) {
    headers.authorization = req.headers.authorization;
  }
  if (req?.headers?.["x-jwt-verified"]) {
    headers["x-jwt-verified"] = req.headers["x-jwt-verified"];
  }
  if (req?.headers?.["x-auth-source"]) {
    headers["x-auth-source"] = req.headers["x-auth-source"];
  }
  return headers;
}

/**
 * Whether a profile currently has an ACTIVE subscription (isCurrent + status
 * "Active"), and its membershipCategory if so. Any other state - lapsed,
 * cancelled, resigned, or no subscription at all - resolves to non-member.
 */
async function getActiveMembership({ profileId, tenantId, req }) {
  if (!profileId) return { isActiveMember: false, membershipCategory: null };

  const base = SUBSCRIPTION_SERVICE_URL.replace(/\/$/, "");
  try {
    const response = await axios.get(
      `${base}/api/v1/subscriptions/profile/${profileId}/current`,
      { headers: buildHeaders(req, tenantId), timeout: 15000 },
    );
    const subscription = response.data?.data || null;
    return {
      isActiveMember: !!subscription,
      membershipCategory: subscription?.membershipCategory || null,
    };
  } catch (error) {
    console.error("[subscriptionLookup] getActiveMembership failed:", error.message);
    return { isActiveMember: false, membershipCategory: null };
  }
}

module.exports = { getActiveMembership };
