/**
 * Caller-class-aware PDP permission for registration routes (P5 batch 2).
 *
 * - CRM callers: the existing `events:<action>` policy middleware, unchanged
 *   (no fallback of any kind for CRM, and none for admin routes - those
 *   don't use this module).
 * - PORTAL callers: `registrations:<action>` (REGISTRATIONS_CREATE/READ/WRITE)
 *   only, evaluated directly via evaluatePermission() below. Every denial, an
 *   outage or an error is final (fail closed). The P5 transition fallback to the
 *   legacy `events:<action>` was retired in P8 (switched off, verified on DEV
 *   with a live portal create + read, then deleted).
 * - Anything else (missing/unknown userType): 403 FORBIDDEN_CALLER, the PDP is
 *   not consulted.
 *
 * A permission is never ownership: every PORTAL route using this still has
 * its ownership binding (requireCrmOrPortalOwner / submittedByUserId /
 * server-derived identity on create).
 */
const { getTrustedTenant } = require("@membership/policy-middleware");
const { defaultPolicyMiddleware } = require("./policy.middleware.js");

const REGISTRATIONS_RESOURCE = "registrations";
// CRM callers keep the staff events:<action> permission.
const CRM_RESOURCE = "events";

function parseHeaderArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Evaluate one resource:action with the same policy client and the same
 * trusted identity the policy middleware uses:
 *   - gateway-verified headers -> policyClient.evaluateWithHeaders, user/tenant
 *     from x-user-id + getTrustedTenant(req), roles/permissions from headers;
 *   - otherwise a Bearer token -> policyClient.evaluatePolicy, identity from the
 *     PDP's verification of that token only;
 *   - AUTH_BYPASS_ENABLED=true -> PERMIT (same local/test bypass as the middleware).
 * The context NEVER includes body/query/params values.
 *
 * @returns {Promise<{decision:"PERMIT"|"DENY", reason:string, status?:number, result?:object}>}
 */
async function evaluatePermission(req, resource, action) {
  if (process.env.AUTH_BYPASS_ENABLED === "true") {
    return { decision: "PERMIT", reason: "AUTH_BYPASS_ENABLED", result: { user: req.user } };
  }

  const policyClient = defaultPolicyMiddleware.policyClient;
  const headers = req.headers || {};
  const hasGatewayHeaders = headers["x-jwt-verified"] === "true" && headers["x-auth-source"] === "gateway";

  let result;
  if (hasGatewayHeaders) {
    const userId = headers["x-user-id"];
    const tenantId = getTrustedTenant(req);
    if (!userId || !tenantId) return { decision: "DENY", reason: "UNAUTHORIZED", status: 401 };
    result = await policyClient.evaluateWithHeaders(headers, resource, action, {
      userId,
      tenantId,
      userRoles: parseHeaderArray(headers["x-user-roles"]),
      userPermissions: parseHeaderArray(headers["x-user-permissions"]),
    });
  } else {
    const authHeader = headers.authorization || headers.Authorization;
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return { decision: "DENY", reason: "UNAUTHORIZED", status: 401 };
    }
    const token = authHeader.slice("Bearer ".length);
    result = await policyClient.evaluatePolicy(token, resource, action, {
      userId: undefined,
      tenantId: undefined,
      userRoles: [],
      userPermissions: [],
    });
  }

  if (result && result.success && result.decision === "PERMIT") {
    return { decision: "PERMIT", reason: result.reason || "PERMIT", result };
  }
  return { decision: "DENY", reason: (result && result.reason) || "PERMISSION_DENIED", result };
}

/** Mirrors the policy middleware's PERMIT side effects for downstream code. */
function applyPermit(req, result) {
  if (!result) return;
  req.policyContext = result;
  if (result.user) {
    req.user = result.user;
    req.userId = result.user.id;
    req.tenantId = result.user.tenantId;
    req.roles = result.user.roles || [];
    req.permissions = result.user.permissions || [];
  }
}

function denyResponse(res, evaluation, resource, action) {
  if (evaluation.status === 401) {
    return res.status(401).json({ success: false, error: "Authentication required", code: "UNAUTHORIZED", status: 401 });
  }
  return res.status(403).json({
    success: false,
    error: "Insufficient permissions",
    reason: evaluation.reason || "PERMISSION_DENIED",
    code: "PERMISSION_DENIED",
    resource,
    action,
  });
}

/**
 * @param {"create"|"read"|"write"} action  exact action for registrations:* (PORTAL)
 *        and for the CRM events:* permission
 * @param {{evaluate?: Function}} [options] test seam; production always uses evaluatePermission
 */
function requireRegistrationPermission(action, { evaluate = evaluatePermission } = {}) {
  const crmMiddleware = defaultPolicyMiddleware.requirePermission(CRM_RESOURCE, action);

  return async function registrationPermission(req, res, next) {
    const userType = typeof req.user?.userType === "string" ? req.user.userType : null;
    if (userType === "CRM") return crmMiddleware(req, res, next);
    if (userType !== "PORTAL") {
      return res.status(403).json({
        success: false,
        error: "Caller type is not permitted for this operation",
        code: "FORBIDDEN_CALLER",
        status: 403,
      });
    }

    try {
      const primary = await evaluate(req, REGISTRATIONS_RESOURCE, action);
      if (primary.decision === "PERMIT") {
        applyPermit(req, primary.result);
        return next();
      }
      return denyResponse(res, primary, REGISTRATIONS_RESOURCE, action);
    } catch (error) {
      // Fail closed on any evaluation error.
      return res.status(500).json({ success: false, error: "Authorization service error", code: "POLICY_SERVICE_ERROR" });
    }
  };
}

module.exports = {
  requireRegistrationPermission,
  evaluatePermission,
};
