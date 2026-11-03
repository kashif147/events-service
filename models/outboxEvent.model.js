const mongoose = require("mongoose");

// P5 transactional outbox (events-service's own DB). A row is written in the SAME Mongo transaction
// as the state change it describes, then published by services/outbox.service.js with a broker
// confirm (publisher.publishConfirmed). eventKey is deterministic and is the published eventId, so a
// re-publish after a lost confirm is deduplicated by the consumer (audit-service: UNIQUE
// (tenant_id, event_id)). Local copy of the profile-service pattern - no cross-service import.
const OutboxEventSchema = new mongoose.Schema(
  {
    eventKey: { type: String, required: true },
    tenantId: { type: String, required: true },
    routingKey: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    correlationId: { type: String, default: null },
    status: { type: String, enum: ["PENDING", "PUBLISHED"], default: "PENDING" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: { type: String, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "outboxEvents" },
);

OutboxEventSchema.index({ eventKey: 1 }, { unique: true });
OutboxEventSchema.index({ status: 1, nextAttemptAt: 1 });
OutboxEventSchema.index(
  { publishedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: "PUBLISHED" } },
);

module.exports = mongoose.models.OutboxEvent || mongoose.model("OutboxEvent", OutboxEventSchema);
