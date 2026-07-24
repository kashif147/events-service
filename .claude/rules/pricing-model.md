# Pricing model shared by Event and EventSession

`models/pricingTier.schema.js` (`PricingTierSchema`) is embedded in both `Event` and
`EventSession` — a session with no pricing of its own falls back to the parent event's
price/tiers (see `resolveAmount()`'s `hasOwnPricing` check), so per-day pricing is opt-in,
not required.

Tier types: `EARLY_BIRD_MEMBER`/`EARLY_BIRD_NON_MEMBER` (cutoff-date bound), `STUDENT`
(flat), `GROUP_STUDENT` (per-person, gated on `minGroupSize`).

When adding a new tier concept, thread it through all three places that currently
enumerate tier types in parallel — missing one leaves the new tier partially working:

1. `pricingTier.schema.js`'s enum
2. `pricingResolution.service.js`'s `resolveUnitPriceForEntity`/`resolvePriceForTierKey`
3. `registration.controller.js`'s `LINE_ITEM_TIER_KEYS`
