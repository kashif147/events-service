# Registration flow — the transactional core

Read `controllers/registration.controller.js` first; `createRegistration` is the shape
everything else follows:

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
- **Multi-tier `lineItems`** (CRM only, events only) — the operator explicitly picks
  tier+quantity pairs (e.g. 2 Member + 1 Non-member) summed into one `amount`/
  `priceBreakdown` via `resolveLineItemsAmount()`/`resolvePriceForTierKey()`, so
  account-service still sees exactly one registration → one payment. `priceCategory`
  becomes `"mixed"` once more than one tier is used.

## Payment methods

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
