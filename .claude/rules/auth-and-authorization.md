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
- `requireIdentifiedCrmOrPortal` — self-scoped by construction: `GET /mine`,
  `POST .../attendance/self`, `POST /` (create). CRM or PORTAL with a non-empty verified user
  id (else 403 `FORBIDDEN_CALLER` / `NOT_OWNER`); it records `req.verifiedCaller` **before**
  the PDP runs, because on PERMIT the policy middleware replaces `req.user` with the PDP's
  user object — controllers read the caller class from `req.verifiedCaller`, not `req.user`.

`tests/registrationObjectAuthz.p5.test.js` and `tests/eventsAdminRegistrationsAuthz.p5b2.test.js`
are the matrix for this; new registration routes must pick one of the gates and extend them.

## Registration permissions: `registrations:*` for PORTAL (P5 batch 2)

The portal self-service routes (`POST /`, `GET /mine`, `GET /:id`, `PUT /:id/cancel`,
`GET .../checkin-qr`, `POST .../attendance/self`) use
`requireRegistrationPermission(action)` (`middlewares/registrationPermission.mw.js`), after the
caller-class/ownership gate:

- CRM → `events:<action>` (unchanged).
- PORTAL → `registrations:<action>` (codes `REGISTRATIONS_CREATE/READ/WRITE`), evaluated
  directly by `evaluatePermission(req, resource, action)` — the same policy client the
  middleware uses (`evaluateWithHeaders` for gateway headers, `evaluatePolicy` for a Bearer),
  with the trusted user/tenant only, never body/query. Every denial is final: an absent
  permission, token/tenant failures, `POLICY_SERVICE_ERROR` and evaluation errors/timeouts all
  fail closed. On PERMIT it sets `req.policyContext`/`req.user`/`req.userId`/`req.tenantId` like
  the middleware. The P5 transition fallback to the legacy `events:<action>`
  (`LEGACY_PORTAL_EVENTS_PERMISSION_FALLBACK`) was retired in P8: switched off and verified on
  DEV (live portal create + read; the portal write path by automated tests), then deleted.
  **Rollout prerequisite in any other environment:** its MEMBER / NON-MEMBER roles must carry
  `REGISTRATIONS_CREATE/READ/WRITE` first, or portal registration breaks there.
- anything else → 403 `FORBIDDEN_CALLER`.

Actions mirror what each route required before the move to `registrations:*`:
create → `create`; `/mine`, `GET /:id`, `attendance/self` → `read`; cancel, checkin-qr → `write`.
A permission never grants another member's registration — ownership is still enforced by
the gates above. Approve/reject and every other staff route stay `requireCrmUser` + `events:*`.

## Event administration is CRM-only (P5 batch 2)

`requireCrmUser` runs before the existing `events:create|write` PDP check on every event,
session, course, certificate-issue and image-upload mutation (before multer on the image
route), and on **all** `/templates` routes (per-user CRM grid "Save View" templates — CRM-only
data; the controller's own `assertCrmUser` stays as a second layer). A PORTAL caller gets 403
`CRM_ONLY` whatever permissions its role holds. Read routes (`GET /events`, `/events/:id`,
`/events/:id/price-quote`, `/courses`, `/courses/:id`) are unchanged (`events:read`, portal
catalogue).
