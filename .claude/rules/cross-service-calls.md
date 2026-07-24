# Cross-service calls: HTTP + forwarded gateway headers, no shared secret

Every outbound call to another service (`services/profileLookup.client.js`,
`services/subscriptionLookup.client.js`, `services/accountService.client.js`,
`services/communicationService.client.js`, `services/lookup.client.js`,
`services/pricing.client.js`) forwards the original caller's gateway-verified headers
(`authorization`, `x-jwt-verified`, `x-auth-source`, `x-user-*`) plus
`x-internal-request: true`. Don't add an API-key/shared-secret env var for a new
cross-service client — forward the caller's headers instead, the same as every existing
client here. See the `cross-service-auth` skill for the platform-wide rule this follows,
and the comment at the top of `accountService.client.js` for why (no req → no forwarded
identity → the call can't happen the same way).

Certificate issuance forwards an explicit allowlist of auth headers
(`FORWARDED_AUTH_HEADERS` in `controllers/certificate.controller.js`) to
`communicationService.client.js`, which calls communication-service's letter-generation
endpoint to actually produce the PDF.

When working from the full `projectShell` checkout (not a standalone clone of just this
service), this pattern is additionally hook-enforced: `.claude/hooks/enforce-hard-rules.mjs`
at the repo root blocks edits that add `x-api-key`/`*_API_KEY`-style headers for new
cross-service clients.
