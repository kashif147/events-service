/**
 * Shared PDP mock for route-level authz tests (use inside jest.mock factory of
 * ../middlewares/policy.middleware.js). Records every evaluated permission in
 * `calls` as "resource:action".
 *
 * - requirePermission(resource, action) (the CRM / staff path): denies when the
 *   request has header x-test-pdp: deny, or x-test-pdp-deny lists the
 *   permission ("res:action", "res:*", comma-separated).
 * - policyClient.evaluatePolicy(token, ...) (direct evaluation used by
 *   requireRegistrationPermission for PORTAL callers): the test token's claims
 *   drive it - pdpDeny: ["res:action" | "res:*" | "*"], pdpReason (deny reason,
 *   default MISSING_PERMISSION), pdpError: true -> transport-style failure
 *   (reason POLICY_SERVICE_ERROR, as the real client returns it).
 */
const jwt = require("jsonwebtoken");

function listed(list, resource, action) {
  return list.includes("*") || list.includes(`${resource}:${action}`) || list.includes(`${resource}:*`);
}

function createPdpMock() {
  const calls = [];
  const defaultPolicyMiddleware = {
    calls,
    requirePermission: (resource, action) => (req, res, next) => {
      calls.push(`${resource}:${action}`);
      const headerList = String(req.headers["x-test-pdp-deny"] || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (req.headers["x-test-pdp"] === "deny" || listed(headerList, resource, action)) {
        return res
          .status(403)
          .json({ success: false, error: "Permission denied", code: "PERMISSION_DENIED", status: 403 });
      }
      return next();
    },
    policyClient: {
      async evaluatePolicy(token, resource, action) {
        calls.push(`${resource}:${action}`);
        const claims = jwt.decode(token) || {};
        if (claims.pdpError) {
          return { success: false, decision: "DENY", reason: "POLICY_SERVICE_ERROR" };
        }
        if (listed(Array.isArray(claims.pdpDeny) ? claims.pdpDeny : [], resource, action)) {
          return { success: false, decision: "DENY", reason: claims.pdpReason || "MISSING_PERMISSION" };
        }
        return {
          success: true,
          decision: "PERMIT",
          reason: "PERMISSION_GRANTED",
          user: { id: claims.sub, tenantId: claims.tenantId, userType: claims.userType, roles: [], permissions: [] },
        };
      },
      async evaluateWithHeaders() {
        throw new Error("gateway-header evaluation is not used by these tests");
      },
    },
  };
  return Object.assign(defaultPolicyMiddleware, { defaultPolicyMiddleware });
}

module.exports = { createPdpMock };
