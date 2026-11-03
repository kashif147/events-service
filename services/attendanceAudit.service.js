// P5 audit facts for attendance corrections, schedule/timezone changes and certificate review flags.
// Each fact is enqueued in the transactional outbox (services/outbox.service.js) inside the same
// Mongo transaction as the change, so a committed change always has its audit event and an aborted
// one never does. audit-service binds and maps these three keys (its PR deploys first).
const mongoose = require("mongoose");
const { enqueueOutboxEvent } = require("./outbox.service.js");

const ROUTING_KEYS = Object.freeze({
  ATTENDANCE_CORRECTED: "events.attendance.corrected.v1",
  SCHEDULE_CHANGED: "events.session.schedule_changed.v1",
  CERTIFICATE_REVIEW_FLAGGED: "events.certificate.review_flagged.v1",
});

function newEventKey(prefix) {
  return `${prefix}.${new mongoose.Types.ObjectId().toHexString()}`;
}

function enqueueAudit(routingKey, prefix, tenantId, data, { session, correlationId } = {}) {
  const eventKey = newEventKey(prefix);
  return enqueueOutboxEvent(
    { eventKey, tenantId, routingKey, correlationId, data: { ...data, tenantId, auditEventKey: eventKey } },
    { session },
  ).then(() => eventKey);
}

module.exports = { ROUTING_KEYS, enqueueAudit };
