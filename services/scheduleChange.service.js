// P5 audited schedule changes. Session timing and the event timezone drive the attendance window,
// so once an event is Published or has any registration, changing them needs an explicit reason and
// is audited (events.session.schedule_changed.v1) in the same transaction as the write. Draft events
// with no registrations can be edited freely (nothing depends on the window yet).
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const { ROUTING_KEYS, enqueueAudit } = require("./attendanceAudit.service.js");

const SCHEDULE_FIELDS = Object.freeze([
  "localDate",
  "endLocalDate",
  "startTime",
  "endTime",
  "startUtcOffset",
  "endUtcOffset",
  "isVirtual",
  "date",
]);
const REASON_MAX = 500;

function normalize(field, v) {
  if (v === undefined || v === null || v === "") return null;
  if (field === "date") {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  return v;
}

/** Schedule fields whose value differs between `before` (stored) and `after` (merged). */
function changedScheduleFields(before, after) {
  const out = {};
  for (const f of SCHEDULE_FIELDS) {
    const a = normalize(f, before?.[f]);
    const b = normalize(f, after?.[f]);
    if (String(a) !== String(b)) out[f] = { from: a, to: b };
  }
  return out;
}

async function scheduleIsAudited(event) {
  if (event.status === "Published") return true;
  return Boolean(await Registration.exists({ tenantId: event.tenantId, eventId: event._id, isDeleted: { $ne: true } }));
}

/**
 * Validates/extracts scheduleChangeReason from a body (and deletes it from the body).
 * @returns {{ reason: string|null, error?: AppError }}
 */
function takeReason(body) {
  const raw = body ? body.scheduleChangeReason : undefined;
  if (body) delete body.scheduleChangeReason;
  if (raw == null) return { reason: null };
  if (typeof raw !== "string" || raw.length > REASON_MAX) {
    return { reason: null, error: new AppError(`scheduleChangeReason must be text of at most ${REASON_MAX} characters`, 400, "INVALID_REASON") };
  }
  return { reason: raw.trim() || null };
}

function reasonRequiredError() {
  return new AppError(
    "A reason is required to change the schedule of a published event or one with registrations",
    400,
    "SCHEDULE_CHANGE_REASON_REQUIRED",
  );
}

/**
 * Rollout switch for the reason requirement (SCHEDULE_REASON_MODE, read per call; default "enforce").
 * "transition" exists only for the window where the deployed CRM predates scheduleChangeReason: an
 * audited schedule change without a reason is accepted, audited with reasonSource "legacy-client" and
 * logged (ids only). Any value other than exactly "transition" enforces.
 */
function scheduleReasonMode() {
  return process.env.SCHEDULE_REASON_MODE === "transition" ? "transition" : "enforce";
}

/**
 * Gate for an audited schedule change. Unaudited changes need nothing.
 * @returns {{ error?: AppError, reasonSource: "client"|"legacy-client"|null }}
 */
function reasonGate({ audited, reason, scope, tenantId, eventId, sessionId = null }) {
  if (!audited) return { reasonSource: null };
  if (reason) return { reasonSource: "client" };
  if (scheduleReasonMode() !== "transition") return { error: reasonRequiredError(), reasonSource: null };
  console.warn("[schedule-change] accepted without reason (SCHEDULE_REASON_MODE=transition)", {
    scope,
    tenantId: tenantId ? String(tenantId) : null,
    eventId: eventId ? String(eventId) : null,
    sessionId: sessionId ? String(sessionId) : null,
  });
  return { reasonSource: "legacy-client" };
}

function auditScheduleChange({ tenantId, eventId, sessionId = null, scope, changes, reason, reasonSource = null, actorUserId, session, correlationId }) {
  return enqueueAudit(
    ROUTING_KEYS.SCHEDULE_CHANGED,
    "sched",
    tenantId,
    {
      scope, // "event-timezone" | "session-add" | "session-update" | "session-delete"
      eventId: String(eventId),
      sessionId: sessionId ? String(sessionId) : null,
      changes,
      reason,
      reasonSource: reasonSource || (reason ? "client" : null),
      actorUserId: actorUserId || null,
      occurredAt: new Date().toISOString(),
    },
    { session, correlationId },
  );
}

module.exports = {
  SCHEDULE_FIELDS,
  changedScheduleFields,
  scheduleIsAudited,
  takeReason,
  reasonRequiredError,
  scheduleReasonMode,
  reasonGate,
  auditScheduleChange,
};
