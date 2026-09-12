const { publisher } = require("@projectShell/rabbitmq-middleware");

// Shares the events.events exchange events-service already owns (see
// registration.events.publisher.js) - published via an explicit {exchange}
// option, bypassing the shared middleware's default exchangeMapping, exactly
// like the registration/certificate events already do.
const EXCHANGE = "events.events";

const ROUTING_KEYS = {
  EVENT_CANCELLED: "events.event.cancelled.v1",
  EVENT_COMPLETED: "events.event.completed.v1",
  EVENT_UNPUBLISHED: "events.event.unpublished.v1",
};

async function publish(routingKey, data, tenantId) {
  const result = await publisher.publish(routingKey, data, {
    tenantId,
    exchange: EXCHANGE,
    routingKey,
    metadata: { service: "events-service", version: "1.0" },
  });
  if (!result.success) {
    console.error("[events-service] Failed to publish", routingKey, result.error);
  }
  return result.success;
}

/**
 * One event-cancelled message carries every refund candidate's payment
 * details - account-service must never query events-service's DB, so this
 * payload is the only information it gets to act on (see
 * eventCancellationRefund.service.js on the account-service side).
 */
async function publishEventCancelled(event, refundCandidates, tenantId) {
  return publish(
    ROUTING_KEYS.EVENT_CANCELLED,
    {
      eventId: String(event._id),
      tenantId,
      eventTitle: event.title,
      refundCandidates: refundCandidates.map((c) => ({
        registrationId: String(c.registrationId),
        paymentId: c.paymentId ? String(c.paymentId) : null,
        stripePaymentIntentId: c.stripePaymentIntentId || null,
        paymentMethod: c.paymentMethod,
        amount: c.amount,
        currency: c.currency,
        profileId: c.profileId || null,
        membershipNumber: c.membershipNumber || null,
      })),
    },
    tenantId,
  );
}

async function publishEventCompleted(event, tenantId) {
  return publish(
    ROUTING_KEYS.EVENT_COMPLETED,
    { eventId: String(event._id), tenantId, eventTitle: event.title },
    tenantId,
  );
}

async function publishEventUnpublished(event, tenantId) {
  return publish(
    ROUTING_KEYS.EVENT_UNPUBLISHED,
    { eventId: String(event._id), tenantId, eventTitle: event.title },
    tenantId,
  );
}

module.exports = {
  EXCHANGE,
  ROUTING_KEYS,
  publishEventCancelled,
  publishEventCompleted,
  publishEventUnpublished,
};
