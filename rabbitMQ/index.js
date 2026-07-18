const {
  init,
  publisher,
  consumer,
  shutdown,
} = require("@projectShell/rabbitmq-middleware");
const { createRabbitStructuredLogHandlers } = require("@projectShell/logging-lib");
const bizLogger = require("../config/bizLogger.js");
const { handlePaymentStatusUpdated } = require("./listeners/payment.status.listener.js");

async function initEventSystem() {
  try {
    await init({
      url: process.env.RABBIT_URL,
      logger: console,
      structuredLog: createRabbitStructuredLogHandlers(bizLogger),
      prefetch: 10,
      connectionName: "events-service",
      serviceName: "events-service",
      // events.events is new and additive - the shared middleware merges this
      // with its default exchange list (user.events, application.events, ...).
      exchanges: [{ name: "events.events", type: "topic", options: { durable: true } }],
    });
    console.log("✅ Event system initialized with middleware");
  } catch (error) {
    console.error("❌ Failed to initialize event system:", error.message);
    throw error;
  }
}

async function setupConsumers() {
  try {
    // Consume account-service's payment-status updates for events/courses
    // registrations, on the existing accounts.events exchange (no new
    // exchange needed there - see account-service Phase 3).
    const PAYMENT_QUEUE = "events.accounts.events";
    await consumer.createQueue(PAYMENT_QUEUE, { durable: true, messageTtl: 3600000 });
    await consumer.bindQueue(PAYMENT_QUEUE, "accounts.events", [
      "payments.events.status.updated.v1",
    ]);

    consumer.registerHandler("payments.events.status.updated.v1", async (payload, context) => {
      bizLogger.business("RabbitMQ events payment status event consumed", {
        eventType: "payments.events.status.updated.v1",
        correlationId: payload.correlationId || null,
        tenantId: payload.data?.tenantId || payload.tenantId || null,
        registrationId: payload.data?.registrationId || null,
        exchange: context.exchange,
        routingKey: context.routingKey,
        queue: PAYMENT_QUEUE,
      });
      await handlePaymentStatusUpdated(payload);
    });

    await consumer.consume(PAYMENT_QUEUE, { prefetch: 10 });
    console.log("✅ Payment status consumer ready:", PAYMENT_QUEUE);

    console.log("✅ All consumers set up successfully");
  } catch (error) {
    console.error("❌ Failed to set up consumers:", error.message);
    throw error;
  }
}

async function shutdownEventSystem() {
  try {
    await shutdown();
    console.log("✅ Event system shutdown complete");
  } catch (error) {
    console.error("❌ Error during event system shutdown:", error.message);
  }
}

module.exports = {
  init,
  publisher,
  consumer,
  shutdown,
  initEventSystem,
  setupConsumers,
  shutdownEventSystem,
};
