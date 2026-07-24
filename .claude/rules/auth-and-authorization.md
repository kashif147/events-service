# Auth and authorization

`middlewares/auth.js`'s `authenticate` is **authentication only**. It trusts
gateway-verified headers (`x-jwt-verified: true` + `x-auth-source: gateway`, validated via
`@membership/policy-middleware/security`), falls back to a raw Bearer JWT, and — only when
`AUTH_BYPASS_ENABLED=true`, and never for anything path-matching
`/login|/signin|/signup|/register|/auth` — accepts a JWT without a full gateway trust chain
(local/test use only). It sets `req.ctx`/`req.user`/`req.userId`/`req.tenantId`. It is
mounted globally in `app.js` (`app.use(authenticate)`) *after* `/health` and `GET /api`, so
those two are the only unauthenticated routes.

Authorization is a separate, per-route concern: `defaultPolicyMiddleware.requirePermission(
resource, action)` from `@membership/policy-middleware` (`middlewares/policy.middleware.js`,
`POLICY_SERVICE_URL`). `middlewares/auth.js` explicitly does **not** export `requireRole`/
`requirePermission` anymore — route new authorization checks through policy-middleware, not
ad hoc role checks added to `auth.js`.
