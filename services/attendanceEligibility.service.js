// Structural checks shared by every path that writes (or mints a credential
// for) a per-session attendance entry - POST .../attendance/self, GET
// .../checkin-qr, POST /public/checkin/:token and PUT .../attendance (CRM) -
// so the four paths can't drift apart. See .claude/rules/attendance.md.
//
// These are structure/eligibility checks only. There is deliberately NO
// attendance time window here yet (product decision pending): until one is
// agreed, an eligible attendee can still self-mark a session of their own
// registration at any time.
const mongoose = require("mongoose");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const { AppError } = require("../errors/AppError.js");

function isValidObjectId(value) {
  return typeof value === "string" && mongoose.isValidObjectId(value) && /^[0-9a-fA-F]{24}$/.test(value);
}

/**
 * 400 before any DB call for a malformed registration/session id (instead
 * of a mongoose CastError surfacing as a 500).
 * @returns {AppError|null}
 */
function validateAttendanceIds({ registrationId, sessionId }) {
  if (!isValidObjectId(String(registrationId ?? ""))) {
    return new AppError("Invalid registration id", 400, "INVALID_REGISTRATION_ID");
  }
  if (!isValidObjectId(String(sessionId ?? ""))) {
    return new AppError("Invalid session id", 400, "INVALID_SESSION_ID");
  }
  return null;
}

/**
 * Per-session attendance only exists for event registrations: EventSession
 * always belongs to an Event, and courses have no session model at all.
 * @returns {AppError|null}
 */
function attendanceTargetError(registration) {
  if (registration.registrationType !== "event" || !registration.eventId) {
    return new AppError(
      "Per-session attendance is not available for this registration",
      409,
      "ATTENDANCE_NOT_SUPPORTED",
    );
  }
  return null;
}

/**
 * The registration must be a live, approved, confirmed booking. Excludes
 * pending / cancelled (isActive:false) / rejected / pending_review /
 * processing, and the post-rollup "attended"/"no-show" states (the rollup
 * has already been computed - attendee-side marking after it changes
 * nothing legitimate; staff corrections go through the CRM route).
 * @returns {AppError|null}
 */
function registrationEligibilityError(registration) {
  const eligible =
    registration.isActive === true &&
    registration.isDeleted !== true &&
    registration.approvalStatus === "approved" &&
    registration.status === "confirmed";
  if (!eligible) {
    return new AppError(
      "This registration is not eligible for attendance",
      409,
      "REGISTRATION_NOT_ELIGIBLE",
    );
  }
  return null;
}

/**
 * Loads the session strictly within the verified tenant AND the
 * registration's own event (non-deleted - the same filter the completion
 * rollup uses, so every session the rollup counts is markable). Missing,
 * deleted, other-event and other-tenant sessions all get the same 404, so a
 * portal caller cannot probe for other sessions.
 * @returns {Promise<{session?: object, error?: AppError}>}
 */
async function loadRegistrationSession({ tenantId, registration, sessionId }) {
  const session = await EventSession.findOne({
    _id: sessionId,
    tenantId,
    eventId: registration.eventId,
    isDeleted: { $ne: true },
  }).lean();
  if (!session) return { error: AppError.notFound("Session not found") };
  return { session };
}

/**
 * Partial attendance: when the event allows it and the registration booked
 * specific sessions, only those sessions are this attendee's - mirrors
 * attendanceRollup.service.js's requiredSessionIds predicate exactly.
 * @returns {Promise<AppError|null>}
 */
async function selectedSessionError({ tenantId, registration, sessionId }) {
  const selected = Array.isArray(registration.sessionIds) ? registration.sessionIds.map(String) : [];
  if (!selected.length) return null;
  const event = await Event.findOne({ _id: registration.eventId, tenantId }).select("allowPartialAttendance").lean();
  if (!event) return AppError.notFound("Event not found");
  if (event.allowPartialAttendance && !selected.includes(String(sessionId))) {
    return new AppError(
      "This session is not part of this registration",
      403,
      "SESSION_NOT_SELECTED",
    );
  }
  return null;
}

/**
 * Full attendee-side check (self route, QR minting, QR redemption):
 * event registration, eligible state, session of the same event in the same
 * tenant, and selected-session membership for partial attendance.
 * @returns {Promise<{session?: object, error?: AppError}>}
 */
async function checkAttendeeAttendance({ tenantId, registration, sessionId }) {
  const targetError = attendanceTargetError(registration);
  if (targetError) return { error: targetError };
  const eligibilityError = registrationEligibilityError(registration);
  if (eligibilityError) return { error: eligibilityError };
  const { session, error } = await loadRegistrationSession({ tenantId, registration, sessionId });
  if (error) return { error };
  const selectionError = await selectedSessionError({ tenantId, registration, sessionId });
  if (selectionError) return { error: selectionError };
  return { session };
}

module.exports = {
  isValidObjectId,
  validateAttendanceIds,
  attendanceTargetError,
  registrationEligibilityError,
  loadRegistrationSession,
  selectedSessionError,
  checkAttendeeAttendance,
};
