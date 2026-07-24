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
