// Computes a Registration's final "attended"/"no-show" status once an event
// completes - see registration.model.js's sessionAttendance field for why
// this is a rollup computed once (at completion) rather than a status
// flipped speculatively mid-event.
const Registration = require("../models/registration.model.js");
const EventSession = require("../models/eventSession.model.js");

/**
 * @param {{registration: object, event: object, sessions: object[]}} params
 *   sessions: every EventSession belonging to the event (not just the ones
 *   this registration covers - allowPartialAttendance decides which subset
 *   is actually required for this specific registration).
 * @returns {"attended"|"no-show"}
 */
function computeRegistrationAttendanceRollup({ registration, event, sessions }) {
  const requiredSessionIds =
    event.allowPartialAttendance && registration.sessionIds?.length
      ? registration.sessionIds.map(String)
      : sessions.map((s) => String(s._id));

  // Nothing to check attendance against (no sessions on this event) - can't
  // gate on a mechanism that doesn't exist, so don't fail the registration
  // over it.
  if (!requiredSessionIds.length) return "attended";

  const attendedSessionIds = new Set(
    (registration.sessionAttendance || [])
      .filter((a) => a.status === "attended")
      .map((a) => String(a.sessionId)),
  );

  const allRequiredAttended = requiredSessionIds.every((id) => attendedSessionIds.has(id));
  return allRequiredAttended ? "attended" : "no-show";
}

/**
 * Applies the rollup to every confirmed, active registration for a completed
 * event, in place - called from event.controller.js's completeEventById
 * right after the status flip. Registrations that are pending/cancelled are
 * left alone (they were never confirmed attendees to begin with).
 */
async function applyAttendanceRollupForCompletedEvent({ event, tenantId }) {
  const [sessions, registrations] = await Promise.all([
    EventSession.find({ tenantId, eventId: event._id, isDeleted: { $ne: true } }).lean(),
    Registration.find({ tenantId, eventId: event._id, isActive: true, status: "confirmed" }),
  ]);

  for (const registration of registrations) {
    registration.status = computeRegistrationAttendanceRollup({ registration, event, sessions });
    await registration.save();
  }

  return registrations;
}

module.exports = { computeRegistrationAttendanceRollup, applyAttendanceRollupForCompletedEvent };
