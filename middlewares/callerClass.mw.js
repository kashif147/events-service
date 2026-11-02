/**
 * Caller-class gates for registration routes (P5 portal object authorization).
 *
 * The caller class is decided ONLY from the verified identity that
 * middlewares/auth.js already attached (gateway-verified x-user-type header,
 * or the verified Bearer JWT's userType claim) - never from body/query/params.
 * events-service has no inbound internal-request mechanism, so a request is
 * either CRM, PORTAL, or denied (fail closed on missing/unknown userType).
 *
 * These are caller-class checks, not permission checks: the existing
 * defaultPolicyMiddleware.requirePermission(...) still runs after them and
 * remains the single source of truth for "does this CRM user hold events:*".
 */

const CRM = "CRM";
const PORTAL = "PORTAL";

function getVerifiedUserType(req) {
  const userType = req.user?.userType;
  // Exact match only (contract: userType === "CRM" / "PORTAL").
  return typeof userType === "string" ? userType : null;
}

function getVerifiedUserId(req) {
  const userId = req.ctx?.userId;
  if (userId === undefined || userId === null) return null;
  const asString = String(userId).trim();
  return asString ? asString : null;
}

function deny(res, code, error) {
  return res.status(403).json({ success: false, error, code, status: 403 });
}

/** Staff-only: userType CRM, then the route's existing PDP permission. */
function requireCrmUser(req, res, next) {
  if (getVerifiedUserType(req) !== CRM) {
    return deny(res, "CRM_ONLY", "This operation is available to CRM users only");
  }
  return next();
}

/**
 * CRM (tenant-scoped, as before) or a PORTAL caller acting on their OWN
 * registration. For PORTAL, req.registrationOwnerUserId is set to the
 * verified user id; controllers must add it to their query as
 * submittedByUserId (the same binding GET /registrations/mine uses).
 */
function requireCrmOrPortalOwner(req, res, next) {
  const userType = getVerifiedUserType(req);
  if (userType === CRM) {
    req.registrationOwnerUserId = null;
    return next();
  }
  if (userType === PORTAL) {
    const userId = getVerifiedUserId(req);
    // A nullish id must never reach the query: submittedByUserId defaults to
    // null, so an empty owner filter would match every CRM-created row.
    if (!userId) return denyNotOwner(res);
    req.registrationOwnerUserId = userId;
    return next();
  }
  return deny(res, "FORBIDDEN_CALLER", "Caller type is not permitted for this operation");
}

/**
 * Builds the registration query for a route guarded by
 * requireCrmOrPortalOwner. Adds the ownership binding for PORTAL callers.
 */
function ownerScopedRegistrationQuery(req, baseQuery) {
  if (req.registrationOwnerUserId) {
    return { ...baseQuery, submittedByUserId: req.registrationOwnerUserId };
  }
  return baseQuery;
}

/** True when a not-found result must be reported as NOT_OWNER (PORTAL). */
function isPortalOwnerScoped(req) {
  return Boolean(req.registrationOwnerUserId);
}

/**
 * Same 403 whether the registration is someone else's, in another tenant, or
 * doesn't exist at all - so a PORTAL caller can't probe for existence.
 */
function denyNotOwner(res) {
  return deny(res, "NOT_OWNER", "You can only access your own registrations");
}

module.exports = {
  requireCrmUser,
  requireCrmOrPortalOwner,
  ownerScopedRegistrationQuery,
  isPortalOwnerScoped,
  denyNotOwner,
};
