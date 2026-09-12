// Applies Zoom/Teams post-meeting attendance data onto every applicable
// registration's sessionAttendance - called by jobs/onlineAttendanceSyncSweep.js
// once a session's scheduled end time has passed.
const Registration = require("../models/registration.model.js");
const zoomClient = require("./zoomIntegration.client.js");
const graphClient = require("./msGraphMeetings.client.js");

/** HH:mm string + a base date -> minutes since midnight, for duration math. */
function minutesOfDay(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function scheduledMinutesForSession(session) {
  const start = minutesOfDay(session.startTime);
  const end = minutesOfDay(session.endTime);
  if (start == null || end == null || end <= start) return null;
  return end - start;
}

/** A registration is "applicable" to a session if it registered for every
 * session (sessionIds empty - the non-partial-attendance default) or
 * explicitly included this one. */
function registrationAppliesToSession(registration, session) {
  if (!registration.sessionIds?.length) return true;
  return registration.sessionIds.some((id) => String(id) === String(session._id));
}

/**
 * @param {object} session an EventSession doc with meeting.provider set
 * @returns {Promise<Array<{email: string, durationSeconds: number}>>}
 */
async function fetchParticipants(session) {
  if (session.meeting?.provider === "zoom") {
    if (!session.meeting.externalMeetingId) {
      throw new Error("Zoom session has no externalMeetingId to look up");
    }
    return zoomClient.getMeetingParticipants(session.meeting.externalMeetingId);
  }
  if (session.meeting?.provider === "teams") {
    if (!session.meeting.organizerUpn || !session.meeting.joinUrl) {
      throw new Error("Teams session is missing organizerUpn or joinUrl - cannot look up its attendance report");
    }
    return graphClient.getAttendanceReport(session.meeting.organizerUpn, session.meeting.joinUrl);
  }
  throw new Error(`Unsupported/unset meeting provider: ${session.meeting?.provider}`);
}

/**
 * Syncs one session's attendance for every applicable, confirmed
 * registration - writes an explicit sessionAttendance entry ("attended" or
 * "absent") for each, including registrants who never joined at all, so the
 * per-session record is a complete, auditable picture rather than only
 * covering people who showed up. Never overwrites an existing "manual-crm"
 * entry - a human correction always wins over a later auto-sync.
 */
async function syncSessionAttendance({ event, session, tenantId }) {
  const participants = await fetchParticipants(session);
  const durationBySeconds = new Map(participants.map((p) => [p.email, p.durationSeconds]));
  const scheduledMinutes = scheduledMinutesForSession(session);
  const method = session.meeting.provider; // "zoom" | "teams"

  const registrations = await Registration.find({
    tenantId,
    eventId: event._id,
    isActive: true,
    status: "confirmed",
  });

  let synced = 0;
  for (const registration of registrations) {
    if (!registrationAppliesToSession(registration, session)) continue;

    const existingIndex = registration.sessionAttendance.findIndex(
      (a) => String(a.sessionId) === String(session._id),
    );
    if (existingIndex >= 0 && registration.sessionAttendance[existingIndex].method === "manual-crm") {
      continue; // a CRM correction already decided this - don't overwrite it
    }

    const email = registration.attendeeSnapshot?.normalizedEmail;
    const durationSeconds = (email && durationBySeconds.get(email)) || 0;
    const connectedMinutes = Math.round(durationSeconds / 60);
    const connectedPercent = scheduledMinutes ? Math.round((connectedMinutes / scheduledMinutes) * 100) : null;
    const status =
      connectedPercent != null
        ? connectedPercent >= (event.attendanceMinPercent ?? 80)
          ? "attended"
          : "absent"
        : connectedMinutes > 0
          ? "attended"
          : "absent";

    const entry = {
      sessionId: session._id,
      status,
      method,
      markedAt: new Date(),
      connectedMinutes,
      scheduledMinutes,
      connectedPercent,
    };

    if (existingIndex >= 0) {
      registration.sessionAttendance[existingIndex].set(entry);
    } else {
      registration.sessionAttendance.push(entry);
    }
    await registration.save();
    synced += 1;
  }

  return { synced, participantCount: participants.length };
}

module.exports = { syncSessionAttendance, scheduledMinutesForSession, registrationAppliesToSession };
