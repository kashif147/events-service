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

## Registration routes: caller class before the PDP (P5)

PORTAL roles hold `events:read/create/write` (self-service registration needs them), so the
PDP permission alone can't separate staff from members. `routes/registration.routes.js`
therefore runs a caller-class gate from `middlewares/callerClass.mw.js` **before**
`requirePermission`, decided only from the verified `req.user.userType` (fail closed on a
missing/unknown value; there is no inbound internal-request path in this service):

- `requireCrmUser` (403 `CRM_ONLY`) — `GET /`, `GET /profile/:profileId`,
  `POST /attendee-duplicate-check`, `PUT /:id/attendee`, `PUT /:id/approve`,
  `PUT /:id/reject`, `POST /:id/retry-payment`, `PUT /:id/sessions/:sessionId/attendance`.
- `requireCrmOrPortalOwner` — `GET /:id`, `PUT /:id/cancel`,
  `GET /:id/sessions/:sessionId/checkin-qr`: CRM tenant-wide; PORTAL only when
  `submittedByUserId` equals the verified user id (the controller adds it to the query via
  `ownerScopedRegistrationQuery`). A PORTAL miss — other member, other tenant, or
  nonexistent — is always 403 `NOT_OWNER`, so existence never leaks.
- Unchanged, self-scoped by construction: `GET /mine`, `POST .../attendance/self`;
  `POST /` (create) is not caller-gated.

`tests/registrationObjectAuthz.p5.test.js` is the matrix for this; new registration routes
must pick one of the two gates (or be self-scoped by construction) and extend it.
