// Structural checks shared by every path that writes (or mints a credential
// for) a per-session attendance entry - POST .../attendance/self, GET
// .../checkin-qr, POST /public/checkin/:token and PUT .../attendance (CRM) -
// so the four paths can't drift apart. See .claude/rules/attendance.md.
//
// Attendee-side paths additionally pass the P5 time window
// (services/attendanceWindow.service.js): self = virtual sessions only,
// opens start-30 min, closes end+15 min; organiser QR scan closes end+60 min;
// QR minting is allowed before the window opens but never after it closes.
// Missing/invalid timezone or incomplete session timing fails closed (409).
const mongoose = require("mongoose");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const { AppError } = require("../errors/AppError.js");
const { checkWindow, computeWindow, PATHS } = require("./attendanceWindow.service.js");

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
async function selectedSessionError({ tenantId, registration, sessionId, event: loaded }) {
  const selected = Array.isArray(registration.sessionIds) ? registration.sessionIds.map(String) : [];
  if (!selected.length) return null;
  const event =
    loaded || (await Event.findOne({ _id: registration.eventId, tenantId }).select("allowPartialAttendance").lean());
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
function windowAppError(e) {
  // opensAt / closesAt (ISO) ride along as top-level error fields so the client can show them.
  return new AppError(e.message, e.status || 409, e.code, e.details ? { ...e.details } : {});
}

/**
 * Full attendee-side check (self route, QR minting, organiser QR scan):
 * event registration, eligible state, session of the same event in the same
 * tenant, selected-session membership for partial attendance, then the time
 * window for `path` (PATHS.SELF | PATHS.QR_SCAN | PATHS.QR_MINT).
 * @returns {Promise<{session?: object, event?: object, window?: {opensAt, closesAt}, error?: AppError}>}
 */
async function checkAttendeeAttendance({ tenantId, registration, sessionId, path, now = new Date() }) {
  if (!Object.values(PATHS).includes(path) || path === PATHS.CRM) {
    throw new Error("checkAttendeeAttendance: an attendee path is required");
  }
  const targetError = attendanceTargetError(registration);
  if (targetError) return { error: targetError };
  const eligibilityError = registrationEligibilityError(registration);
  if (eligibilityError) return { error: eligibilityError };
  const { session, error } = await loadRegistrationSession({ tenantId, registration, sessionId });
  if (error) return { error };
  const event = await Event.findOne({ _id: registration.eventId, tenantId })
    .select("allowPartialAttendance timezone")
    .lean();
  if (!event) return { error: AppError.notFound("Event not found") };
  const selectionError = await selectedSessionError({ tenantId, registration, sessionId, event });
  if (selectionError) return { error: selectionError };
  const w = checkWindow({ timezone: event.timezone, session, path, now });
  if (w.error) return { error: windowAppError(w.error), session, event };
  return { session, event, window: { opensAt: w.opensAt, closesAt: w.closesAt } };
}

/**
 * CRM correction context: the widest (QR) window, or unavailable. Never blocks the correction -
 * it only decides whether a reason is required.
 * @returns {Promise<{outsideWindow: boolean}>}
 */
async function correctionWindowContext({ tenantId, registration, session, now = new Date() }) {
  const event = await Event.findOne({ _id: registration.eventId, tenantId }).select("timezone").lean();
  const w = computeWindow({ timezone: event?.timezone, session, path: PATHS.QR_SCAN });
  if (w.error) return { outsideWindow: true };
  const t = now.getTime();
  return { outsideWindow: t < w.opensAt.getTime() || t > w.closesAt.getTime() };
}

module.exports = {
  isValidObjectId,
  validateAttendanceIds,
  attendanceTargetError,
  registrationEligibilityError,
  loadRegistrationSession,
  selectedSessionError,
  checkAttendeeAttendance,
  correctionWindowContext,
  windowAppError,
};
