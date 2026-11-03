// P5 durable audit delivery for attendance / schedule / certificate-review facts.
//
//   enqueueOutboxEvent(...,{ session })  - inside the caller's Mongo transaction, next to the state
//                                          change; a duplicate eventKey is a no-op (same fact).
//   relayOutboxOnce()                    - publishes PENDING rows with a BROKER CONFIRM
//                                          (publisher.publishConfirmed on the events.events exchange,
//                                          explicit routing key, eventId = eventKey); only a confirmed
//                                          publish marks the row PUBLISHED. Failure -> exponential
//                                          backoff (1 s .. 15 min), error log after 24 h; never dropped.
//
// Delivery is at-least-once: a confirm lost after the broker accepted the message re-publishes the
// same eventId, which audit-service ignores (UNIQUE (tenant_id, event_id)). A confirm only proves the
// broker accepted the message, not that a queue was bound - audit-service's binding for these keys
// must be deployed BEFORE this events-service version (see .claude/rules/attendance.md).
// Single-instance assumption like the other in-process jobs (a second instance only duplicates
// publishes, which the consumer dedupes).
const OutboxEvent = require("../models/outboxEvent.model.js");

const EXCHANGE = "events.events";
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const ALERT_AFTER_MS = 24 * 3600 * 1000;
const EVENT_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

let publishFn = null;
async function defaultPublish(row) {
  const { publisher } = require("@projectShell/rabbitmq-middleware");
  const r = await publisher.publishConfirmed(row.routingKey, row.data, {
    eventId: row.eventKey,
    tenantId: row.tenantId,
    correlationId: row.correlationId || row.eventKey,
    exchange: EXCHANGE,
    routingKey: row.routingKey,
    metadata: { service: "events-service", version: "1.0" },
  });
  return r && r.success === true ? { ok: true } : { ok: false, error: (r && r.error) || "publish failed" };
}
/** Test seam: fn(row) -> {ok, error?}. */
function setOutboxPublisher(fn) {
  publishFn = fn;
}

async function enqueueOutboxEvent({ eventKey, tenantId, routingKey, data, correlationId }, { session } = {}) {
  if (!EVENT_KEY.test(String(eventKey || ""))) throw new Error("enqueueOutboxEvent: eventKey must be 8-128 chars [A-Za-z0-9._:-]");
  if (!tenantId || !routingKey) throw new Error("enqueueOutboxEvent: tenantId and routingKey are required");
  const res = await OutboxEvent.updateOne(
    { eventKey },
    {
      $setOnInsert: {
        eventKey,
        tenantId: String(tenantId),
        routingKey,
        data,
        correlationId: correlationId || eventKey,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
    },
    { upsert: true, session },
  );
  return { created: Boolean(res.upsertedCount) };
}

function backoffMs(attempts) {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

async function relayOutboxOnce({ now = new Date(), limit = 50 } = {}) {
  const publish = publishFn || defaultPublish;
  const due = await OutboxEvent.find({ status: "PENDING", nextAttemptAt: { $lte: now } })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .lean();
  let published = 0;
  let failed = 0;
  for (const row of due) {
    let result;
    try {
      result = await publish(row);
    } catch (err) {
      result = { ok: false, error: err?.message || "publish threw" };
    }
    if (result && result.ok) {
      published += 1;
      await OutboxEvent.updateOne(
        { _id: row._id, status: "PENDING" },
        { $set: { status: "PUBLISHED", publishedAt: new Date(), lastError: null }, $inc: { attempts: 1 } },
      );
    } else {
      failed += 1;
      const attempts = (row.attempts || 0) + 1;
      await OutboxEvent.updateOne(
        { _id: row._id, status: "PENDING" },
        {
          $set: { nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), lastError: String(result?.error || "publish failed").slice(0, 200) },
          $inc: { attempts: 1 },
        },
      );
      if (now - new Date(row.createdAt) > ALERT_AFTER_MS) {
        console.error("[outbox] audit event undelivered for over 24h", { eventKey: row.eventKey, routingKey: row.routingKey, attempts });
      }
    }
  }
  return { due: due.length, published, failed };
}

let timer = null;
let stopped = true;
function startOutboxRelay({ intervalMs = Number(process.env.OUTBOX_RELAY_INTERVAL_MS || 2000) } = {}) {
  if (!stopped) return;
  stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await relayOutboxOnce();
    } catch (err) {
      console.warn("[outbox] relay tick failed", { name: err?.name, code: err?.code ?? null });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
}
function stopOutboxRelay() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { EXCHANGE, enqueueOutboxEvent, relayOutboxOnce, startOutboxRelay, stopOutboxRelay, setOutboxPublisher, backoffMs };
