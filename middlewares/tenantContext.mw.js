const { tenantContextMiddleware } = require("@membership/policy-middleware");

/**
 * Phase 1A canonical tenant-context guard — WARN MODE ONLY (non-blocking).
 *
 * Mounted globally in app.js right AFTER `app.use(authenticate)` (the trusted
 * identity/tenant-establishing middleware) and BEFORE the `/api` routers, so it
 * runs before each route's `requirePermission(...)`:
 *   authenticate -> tenantContextWarn -> requirePermission -> handler
 *
 * It observes the trusted tenant already on req.ctx/req.user/req.tenantId,
 * re-pins req.tenantId to it, and LOGS any caller-supplied (body/query/params)
 * tenantId that disagrees as a non-blocking TenantContextMismatch event. It
 * never returns 403.
 *
 * events-service controllers already derive tenant from `req.ctx?.tenantId ||
 * req.tenantId` (no caller-supplied body/query/header fallback), so the guard's
 * re-pinned trusted tenant aligns directly with existing controller behaviour.
 */
const tenantContextWarn = tenantContextMiddleware({ mode: "warn" });

module.exports = {
  tenantContextWarn,
};
