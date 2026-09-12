# RabbitMQ

`rabbitMQ/index.js` binds `events.accounts.events` to the *existing* `accounts.events`
exchange (routing key `payments.events.status.updated.v1`) rather than a new exchange —
this service is a consumer of account-service's payment lifecycle, not the owner of it.

Outbound, `rabbitMQ/publishers/registration.events.publisher.js` publishes registration/
certificate lifecycle events (`events.registration.created/confirmed/cancelled.v1`,
`events.certificate.issued.v1`) on its own `events.events` exchange, which audit-service
and communication-service both consume (see those services' `CLAUDE.md` files). Keep
routing-key names in sync with what those consumers expect if you change them here —
renaming a routing key on this side without coordinating breaks both consumers silently.
`publishCertificateIssued`'s payload was additively extended (`eventId`/`eventTitle`/
`certificationType`/`cpdCredits`/`accreditationBody`/`issuedAt`, same routing key) so
profile-service can also consume it (`events.certificate.issued.v1` → its new
`Qualification` record) — see `certificates-and-qualification.md`.

`rabbitMQ/publishers/event.lifecycle.publisher.js` publishes the *event-level* (not
per-registration) lifecycle keys on the same `events.events` exchange:
`events.event.cancelled.v1` (fired by `cancelEvent`, carries a `refundCandidates` array with
everything account-service needs to refund each affected registration without querying this
service's DB — see `event.controller.js`), `events.event.completed.v1` (fired by
`completeEventById`, called from both the manual `PUT /:id/complete` endpoint and
`jobs/eventCompletionSweep.js`), and `events.event.unpublished.v1` (audit-trail only, no
required consumer today). account-service binds a new `accounts.events.events` queue to
this exchange for `events.event.cancelled.v1` — see its own `CLAUDE.md`.
