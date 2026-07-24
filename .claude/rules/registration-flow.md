# Registration flow — the transactional core

Read `controllers/registration.controller.js` first; `createRegistration` is the shape
everything else follows:

1. validate
2. check seat capacity (event- and session-level)
3. resolve/create the attendee `Profile` via `services/profileLookup.client.js` (attendee-only
   profiles never enter the membership application pipeline)
4. verify *real* membership status via `services/subscriptionLookup.client.js` — never trust
   a client-supplied membership claim for pricing
5. price via `services/pricingResolution.service.js` (see `pricing-model.md`)
6. create the `Registration`
7. take payment via `services/accountService.client.js`
8. publish a domain event

**No Mongo transaction wraps this.** If pricing or payment fails after the `Registration`
doc (and possibly a new attendee `Profile`) were created, both are rolled back manually
(`Registration.deleteOne` / `deleteAttendeeProfile`). Any new failure path added to this
flow must extend that same manual rollback — don't assume atomicity, there is none.

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

`stripe` creates a payment intent, registration starts `pending`, gets confirmed later via
the `payments.events.status.updated.v1` RabbitMQ event (see
`rabbitMQ/listeners/payment.status.listener.js`). `manual`/`comp`/`invoice` post straight to
the GL via `postManualRegistrationPayment`, registration is `confirmed` immediately.

`approveRegistration` (staff manually confirming an out-of-band payment) relies on the
atomic `findOneAndUpdate({status: "pending"}, {status: "confirmed"})` guard as its **only**
idempotency mechanism. Don't call `postManualRegistrationPayment` outside that guarded
transition — it mints a fresh GL `Payment` on every call, so calling it twice double-books.

## Duplicate-booking check lives in one place

`Registration`'s unique index is `{tenantId, eventId|courseId, profileId}` scoped to
`isActive: true` (see `models/registration.model.js` and
`scripts/migrate-registration-isActive-index.js`) — cancelling a registration flips
`isActive: false` specifically so the same profile can re-register for the same
event/course afterward. This index is the single source of truth for "is this a duplicate
booking" — don't add a second check for it elsewhere.
