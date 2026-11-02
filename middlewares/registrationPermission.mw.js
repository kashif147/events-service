/**
 * Caller-class-aware PDP permission for registration routes (P5 batch 2).
 *
 * - CRM callers: the existing `events:<action>` permission, unchanged.
 * - PORTAL callers: the new `registrations:<action>` resource
 *   (REGISTRATIONS_CREATE/READ/WRITE). TRANSITION ONLY: while those codes
 *   are not yet in the permission catalogue / portal roles, a PDP denial of
 *   `registrations:<action>` falls back to the PORTAL route's legacy
 *   `events:<action>` permission, so DEV keeps working. Remove the fallback
 *   by setting LEGACY_PORTAL_EVENTS_PERMISSION_FALLBACK to false (then delete
 *   the legacy branch) once the catalogue + role change has shipped.
 * - Anything else (missing/unknown userType): 403 FORBIDDEN_CALLER.
 *
 * A permission is never ownership: every PORTAL route using this still has
 * its ownership binding (requireCrmOrPortalOwner / submittedByUserId /
 * server-derived identity on create) - holding registrations:* or events:*
 * never reaches another member's registration.
 *
 * Only the existing policy middleware (`requirePermission`) is used - no PDP
 * logic is reimplemented here, so gateway-header, Bearer and bypass modes
 * all behave exactly as they do on every other route.
 */
const { defaultPolicyMiddleware } = require("./policy.middleware.js");

// TEMPORARY (P5 transition). Single switch to remove once REGISTRATIONS_*
// is in the catalogue and granted to the portal member roles.
const LEGACY_PORTAL_EVENTS_PERMISSION_FALLBACK = true;

const REGISTRATIONS_RESOURCE = "registrations";
const LEGACY_RESOURCE = "events";

function denyCaller(res) {
  return res.status(403).json({
    success: false,
    error: "Caller type is not permitted for this operation",
    code: "FORBIDDEN_CALLER",
    status: 403,
  });
}

/**
 * Runs one requirePermission middleware against a capturing response, so
 * the caller can decide what to do with a denial. Resolves to
 * { permitted: true } or { permitted: false, statusCode, body }.
 */
function evaluateCaptured(middleware, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const shim = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        settle({ permitted: false, statusCode: this.statusCode, body });
        return this;
      },
      send(body) {
        settle({ permitted: false, statusCode: this.statusCode, body });
        return this;
      },
    };
    const next = (err) => {
      if (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }
      settle({ permitted: true });
    };
    Promise.resolve()
      .then(() => middleware(req, shim, next))
      .then(() => {
        // A middleware that returned without responding or calling next is
        // treated as a denial (fail closed).
        settle({
          permitted: false,
          statusCode: 500,
          body: { success: false, error: "Authorization service error", code: "POLICY_SERVICE_ERROR" },
        });
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
  });
}

/**
 * @param {"create"|"read"|"write"} portalAction  action for registrations:* (and its legacy events:* fallback)
 * @param {"create"|"read"|"write"} [crmAction]   action for the CRM events:* permission (defaults to portalAction)
 * @param {{legacyFallback?: boolean}} [options]  test seam; production always uses the constant
 */
function requireRegistrationPermission(
  portalAction,
  crmAction = portalAction,
  { legacyFallback = LEGACY_PORTAL_EVENTS_PERMISSION_FALLBACK } = {},
) {
  const crmMiddleware = defaultPolicyMiddleware.requirePermission(LEGACY_RESOURCE, crmAction);
  const portalMiddleware = defaultPolicyMiddleware.requirePermission(REGISTRATIONS_RESOURCE, portalAction);
  const legacyMiddleware = defaultPolicyMiddleware.requirePermission(LEGACY_RESOURCE, portalAction);

  return async function registrationPermission(req, res, next) {
    const userType = typeof req.user?.userType === "string" ? req.user.userType : null;
    if (userType === "CRM") return crmMiddleware(req, res, next);
    if (userType !== "PORTAL") return denyCaller(res);

    try {
      const primary = await evaluateCaptured(portalMiddleware, req);
      if (primary.permitted) return next();

      const isPermissionDenial =
        primary.statusCode === 403 && primary.body && primary.body.code === "PERMISSION_DENIED";
      if (isPermissionDenial && legacyFallback) {
        // Safe log: resource:action only, no identifiers.
        console.log(
          `[REGISTRATION_PERMISSION] legacy fallback ${REGISTRATIONS_RESOURCE}:${portalAction} -> ${LEGACY_RESOURCE}:${portalAction}`,
        );
        return legacyMiddleware(req, res, next);
      }
      // 401 / 5xx / non-permission 403: replay unchanged, never fall back.
      return res.status(primary.statusCode).json(primary.body);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  requireRegistrationPermission,
  LEGACY_PORTAL_EVENTS_PERMISSION_FALLBACK,
  // exported for tests only
  _evaluateCaptured: evaluateCaptured,
};
