# CLAUDE.md

`events-service` owns Events, Courses, Registrations (bookings/tickets), and Certificates
for the membership platform — CPD events, courses with sessions/deliveries, member vs
non-member vs student pricing, seat capacity, Stripe/manual payment, and post-attendance
certificate issuance. It owns its own MongoDB via Mongoose. Runs on port `4011` (see
`docker-compose.yml` / `package.json`'s `docker:run`).

Unlike the other newer services in this platform, this one is **CommonJS**
(`require`/`module.exports`), not ESM. Before adding `import`/`export` syntax here, grep
for `require(` across the service — if it's everywhere, stay CommonJS.

## Commands

```bash
npm start                # node bin/events-service.js
npm run dev               # nodemon
npm test                  # jest (all tests)
npm test -- <pattern>     # jest, filter by test file/name pattern
npm run test:watch
npm run test:coverage
```

`npm run lint` and `npm run build` are no-op placeholders
(`"No linting/build configured yet"`) — don't expect either to catch anything. Tests live
under `tests/` and match `**/tests/**/*.test.js` (see `package.json`'s `jest` block);
`tests/setup.js` mocks `../rabbitMQ` and `../config/db` and sets
`AUTH_BYPASS_ENABLED=true`/`JWT_SECRET` so `supertest` requests against `app.js` don't need
a real gateway, Mongo, or RabbitMQ. Follow that pattern (mock RabbitMQ/DB, bypass auth via
env, hit `app.js` directly with `supertest`) for new route-level tests instead of spinning
up real infra.

`scripts/` holds one-off maintenance scripts (`migrate-registration-isActive-index.js`,
`seed-grid-system-default-template.js`) — run with `node scripts/<file>.js` directly, not
via npm.

### Auth and authorization
@.claude/rules/auth-and-authorization.md

### Registration flow
@.claude/rules/registration-flow.md

### Pricing model
@.claude/rules/pricing-model.md

### Cross-service calls
@.claude/rules/cross-service-calls.md

### RabbitMQ
@.claude/rules/rabbitmq.md

### Grid "Save View" templates
@.claude/rules/grid-templates.md

### Response envelope
@.claude/rules/response-envelope.md
