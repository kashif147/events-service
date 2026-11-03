# Registration flow — the transactional core

Read `controllers/registration.controller.js` first; `createRegistration` is the shape
everything else follows:

0. derive identity from the **verified caller** (`req.verifiedCaller`, see
   auth-and-authorization.md), never the body: `registeredVia` = `"portal"` for PORTAL /
   `"crm"` for CRM (no verified signal distinguishes the mobile app, so body `registeredVia`,
   including `"mobile"`, is ignored); `registeredByUserId` = the verified CRM user id / `null`
   for PORTAL. For PORTAL, `profile.profileId` / membership number in the body are **ignored**:
   the attendee is the caller's own profile, from profile-service `GET /api/profile/my-profile`
   (`profileLookup.client.js`'s `getCallerOwnProfile`, forwarding the caller's identity headers,
   **no** `x-internal-request`). Lookup failure → 503 `PROFILE_LOOKUP_FAILED` (fail closed). No
   own profile → the duplicate check still runs, but an `exact` match on portal-supplied details
   is recorded as `POTENTIAL_MATCH` (reviewer must decide) and never drives pricing or
   `membershipNumber`. CRM may still target any profile in its tenant (`profile.profileId`).
1. validate
2. check seat capacity (event- and session-level)
3. record a duplicate-detection verdict (`duplicateReview`) via
   `services/profileLookup.client.js`'s `checkAttendeeDuplicates` — **no Profile is created
   or linked here**, for any `registeredVia`. Profile creation/linking is deferred entirely to
   CRM approval (see "Approval is two-phase" below).
4. verify *real* membership status via `services/subscriptionLookup.client.js` — never trust
   a client-supplied membership claim for pricing (tolerates the attendee's Profile not being
   resolved yet)
5. price via `services/pricingResolution.service.js` (see `pricing-model.md`)
6. create the `Registration` at `approvalStatus: "pending_review"`, `profileId: null`
7. authorize/record payment via `services/accountService.client.js` — never captured/posted
   here (see "Payment methods" below)
8. publish `events.registration.created.v1`

**No Mongo transaction wraps this.** If pricing or payment fails after the `Registration` doc
was created, it's rolled back manually (`Registration.deleteOne`). Any new failure path added
to this flow must extend that same manual rollback — don't assume atomicity, there is none.

## Approval is two-phase — Profile creation and payment capture/posting both wait for it

`createRegistration` never creates/links a Profile and never captures a Stripe charge or posts
a manual/comp/invoice payment to the GL — it only records the `duplicateReview` verdict
(`EXACT_MATCH` / `CONFIRMED_LINK` / `POTENTIAL_MATCH` / `NO_MATCH`) and leaves the registration
`pending_review`. All of that — resolving/creating the Profile per the verdict (or an explicit
reviewer `decision` for `POTENTIAL_MATCH`), capturing the authorized Stripe PaymentIntent or
posting the recorded manual/comp/invoice payment to the GL, and confirming the registration —
happens only in `PUT /:id/approve` (`services/registrationApproval.service.js`'s
`finalizeRegistrationApproval`, behind the atomic `claimRegistrationForApproval`
`pending_review` → `processing` guard, which is what makes concurrent/repeat approve attempts
safe). `PUT /:id/reject` is the mirror: cancels the Stripe authorization or voids the recorded-
but-unposted manual/comp/invoice payment, no Profile ever touched. Neither endpoint auto-fires
on its own — every approval is an explicit call (the CRM Add Attendee drawer's "Approve now"/
"Reject" choice, fired right after create, or a later manual decision from view mode).

## Two pricing flows coexist

- **Legacy single-tier** (`quantity`, portal/mobile or a single-tier CRM registration) —
  `determinePriceCategory()` auto-derives `standard`/`student`/`group_student` from the
  attendee's *verified* membership category (undergraduate-student detection lives in
  `services/membershipCategory.util.js`), then `resolveAmount()` prices it against the
  event's/session's `memberPrice`/`nonMemberPrice`/`pricingTiers` (early-bird tiers are
  cutoff-date gated).
- **Multi-tier `lineItems`** (CRM, and also sent by the portal; events only) — the operator explicitly picks
  tier+quantity pairs (e.g. 2 Member + 1 Non-member) summed into one `amount`/
  `priceBreakdown` via `resolveLineItemsAmount()`/`resolvePriceForTierKey()`, so
  account-service still sees exactly one registration → one payment. `priceCategory`
  becomes `"mixed"` once more than one tier is used. For **PORTAL** callers the chosen tier's
  eligibility is checked against the verified membership (`portalTierIneligibility`):
  `MEMBER`/`EARLY_BIRD_MEMBER` need an active membership; `STUDENT` is open to non-members and
  undergraduate-student members only; otherwise 400 `TIER_NOT_ELIGIBLE`. No amount/price is ever
  read from the body — every amount comes from the event/session/course config.

## Payment methods

Server-side allow-list in `createRegistration` (`PAYMENT_METHODS_BY_CALLER`), checked before
any lookup or write — CRM approval is not the protection: PORTAL (and mobile, which is not
distinguishable) → `stripe` only (`manual`/`comp`/`invoice` → 403
`PAYMENT_METHOD_NOT_ALLOWED`); CRM → `stripe`, `manual`, `comp`, `invoice`; anything else,
including `global_payments` (no server-side integration yet), → 400
`PAYMENT_METHOD_NOT_SUPPORTED`.

`manual`/`comp`/`invoice` are *recorded* (a `Payment` doc created, `deferPosting: true`) via
`postManualRegistrationPayment` — not posted to the GL until approval
(`postManualRegistrationPaymentToGL`).

`stripe` has **two different paths depending on who's authorizing the card**, both ending at
the same place (`Registration.stripePaymentIntentId` set, `paymentStatus` reflecting the live
Stripe status) — never create two PaymentIntents for one registration:

- **CRM** (`createRegistration`'s request has no `stripePaymentIntentId`): events-service
  creates a fresh manual-capture PaymentIntent itself via `createRegistrationPaymentIntent`
  (account-service `POST /api/payments/intents`) and returns its `clientSecret` — the CRM Add
  Attendee drawer confirms the card client-side (`stripe.confirmCardPayment`) immediately after,
  in the same submit.
- **Portal/mobile**: the client authorizes payment **directly against account-service**
  (`POST /api/payments/intents` then its own Stripe confirm call) *before* this Registration
  exists — `registrationId` can't be included at that point. It then calls
  `POST /registrations` with the already-authorized `stripePaymentIntentId` in the body.
  `createRegistration` must **not** call `createRegistrationPaymentIntent` in this case — it
  verifies the existing Payment (tenant/purpose/amount/currency match, not already attached to
  another registration, via `getPaymentByPaymentIntentId`) and backfills `registrationId`/
  `productCode`/`eventCategoryCode` onto it via `attachRegistrationToPaymentIntent`
  (account-service `POST /api/payments/intents/:id/attach-registration`) instead of creating a
  second PaymentIntent for a payment the payer already authorized.

P5 payer binding: account-service binds every event/course intent to its verified creator
(`payer`) and the event/course it pays for (`target`), and refuses a `registrationId` on a
PORTAL caller's intent. So the attach call sends the registration's own binding
(`entityType`/`entityId` = `event`|`course` + `eventId`|`courseId`, `purpose`, `amount`,
`currency`), and account-service binds atomically and once: a 409 (`ALREADY_ATTACHED`,
`TARGET_MISMATCH`, `REGISTRATION_ALREADY_HAS_PAYMENT`, ...) lands in the manual rollback (the
Registration is deleted, the caller gets the 409). createRegistration also refuses a PORTAL
intent whose `payer.userId` is another user (403 `NOT_OWNER`) or whose `target` is another
event/course (400), before attaching. A PORTAL `stripe` registration **without** a
`stripePaymentIntentId` creates the intent for the event/course (no `registrationId`) and then
attaches it the same way; only CRM callers create registration-backed intents. Known gap: the
live portal sends `purpose: "eventRegistration"` (and `metadata.eventId`) for courses too, so
portal course Stripe registrations fail the purpose check - there is no purpose mapping in
code to fix this server-side; it needs a portal change (`courseRegistration` + `courseId`).

One payment binding per registration (P5 batch 5): `Registration.paymentId` /
`stripePaymentIntentId` are written by `bindRegistrationPaymentOnce` (conditional update that
only matches an unbound registration, or one already bound to the same payment) at creation, so
a binding that appeared concurrently is a 409 + rollback, never an overwrite. retry-payment is
the only replacement path: a single conditional transition from the binding it read to the one
account-service returned (account-service itself allows one active binding per registration -
`Payment.registrationBinding`); a concurrent change -> 409 `REGISTRATION_PAYMENT_CHANGED`, and
the superseded manual payment is voided only after the transition succeeded. The portal
submits all registrations as `registrationType: "event"`, so its intents are correctly
`eventRegistration` (portal PR #41 makes that one explicit shared mapping).

Either way, capture only ever happens at approval (`finalizeRegistrationApproval` →
`capturePaymentIntent`); cancel only ever happens at rejection (`cancelPaymentIntent`).

## Duplicate-registration protection lives in two indexes now, not one

`Registration.profileId` is always `null` at creation (resolved only at approval — see above),
so the older `{tenantId, eventId|courseId, profileId}` unique index (scoped to `isActive:
true`, partial-filtered to `profileId: {$type:"string"}` so multiple nulls don't collide) no
longer applies to anything at intake — it only guards against approving a *second* registration
for a profile already linked to a *confirmed* one. The real intake-time guard is
`{tenantId, eventId|courseId, attendeeSnapshot.normalizedEmail}` (also `isActive: true`-scoped)
— this is what actually stops two registrations for the same event/course + same attendee email
being created seconds apart (double-click, network retry, anything), since `normalizedEmail` is
the only stable identity signal known before a Profile is resolved. Cancelling/rejecting a
registration flips `isActive: false` on both counts, freeing the slot for a genuine later
re-registration. See `scripts/migrate-registration-profileid-index.js` for the migration (must
be run after resolving any pre-existing active duplicates, or index creation fails on them).
