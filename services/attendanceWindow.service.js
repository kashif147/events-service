// P5 attendance time window (owner-approved policy, 2026-11-03). Pure functions - no DB, no clock
// except the `now` argument - so every rule here is unit-testable with fixed instants.
//
// Policy (v1 constants; no per-event overrides):
//   opens            = session start - 30 min                (all attendee paths)
//   QR scan closes   = session end   + 60 min                (organizer scan, in-person or virtual)
//   self closes      = session end   + 15 min                (portal self-attendance, VIRTUAL sessions only)
//   in-person self   = never                                 (organizer QR scan required)
//
// Instants are computed from the session's explicit local calendar day(s) and "HH:mm" wall-clock
// times in the EVENT's stored IANA timezone. Nothing is guessed:
//   - no event timezone, an invalid one, a missing localDate/startTime/endTime -> fail closed
//     (the legacy `date` field is NOT used: the CRM stored it as browser-local midnight in UTC,
//     so its calendar day is not recoverable server-side);
//   - a wall-clock time that does not exist in the zone (spring-forward gap) -> rejected;
//   - a wall-clock time that exists twice (fall-back overlap) -> requires an explicit stored UTC
//     offset for that endpoint (startUtcOffset / endUtcOffset, "+HH:MM"); never silently chosen;
//   - overnight sessions are supported through an explicit endLocalDate; end must be after start.
const OPEN_BEFORE_MS = 30 * 60 * 1000;
const QR_CLOSE_AFTER_MS = 60 * 60 * 1000;
const SELF_CLOSE_AFTER_MS = 15 * 60 * 1000;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UTC_OFFSET = /^([+-])(0\d|1[0-4]):([0-5]\d)$/;
// IANA names only (Region/City[/...], or UTC). Offsets ("+01:00") and abbreviations ("IST") are
// rejected even where Intl would accept them, so a stored zone always carries its DST rules.
const IANA_NAME = /^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+)$/;

function code(c, message, status = 409) {
  return { code: c, message, status };
}

function isValidIanaTimezone(tz) {
  if (typeof tz !== "string" || !IANA_NAME.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isValidLocalDate(s) {
  const m = typeof s === "string" && LOCAL_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function isValidHhmm(s) {
  return typeof s === "string" && HHMM.test(s);
}

function parseOffsetMinutes(s) {
  const m = typeof s === "string" && UTC_OFFSET.exec(s);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

const formatters = new Map();
function wallClockParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

/** UTC offset (minutes) of `tz` at instant `ms`. */
function offsetAt(ms, tz) {
  const w = wallClockParts(ms, tz);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000) / 60000);
}

/**
 * Every UTC instant whose wall clock in `tz` is localDate + hhmm: 0 (gap), 1, or 2 (overlap).
 * @returns {number[]} ms, ascending
 */
function localCandidates(localDate, hhmm, tz) {
  const [y, mo, d] = localDate.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = new Set([-36, -12, 0, 12, 36].map((hrs) => offsetAt(asUtc + hrs * 3600000, tz)));
  const out = new Set();
  for (const o of offsets) {
    const t = asUtc - o * 60000;
    const w = wallClockParts(t, tz);
    if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Resolve one session endpoint to a single instant, or an explicit error.
 * @returns {{ ms?: number, error?: {code,message,status}, ambiguous?: boolean }}
 */
function resolveLocalInstant({ localDate, time, tz, utcOffset, which }) {
  const c = localCandidates(localDate, time, tz);
  if (c.length === 0) {
    return { error: code("SESSION_TIME_NONEXISTENT", `The session ${which} time does not exist in ${tz} on ${localDate} (clock change)`, 400) };
  }
  if (c.length === 1) {
    if (utcOffset != null && utcOffset !== "") {
      const o = parseOffsetMinutes(utcOffset);
      if (o === null || offsetAt(c[0], tz) !== o) {
        return { error: code("SESSION_UTC_OFFSET_MISMATCH", `The ${which} UTC offset does not match ${tz} at that time`, 400) };
      }
    }
    return { ms: c[0] };
  }
  // Ambiguous (fall-back overlap): only an explicit stored offset may pick one.
  const o = parseOffsetMinutes(utcOffset);
  if (o === null) {
    return {
      ambiguous: true,
      error: code("SESSION_TIME_AMBIGUOUS", `The session ${which} time occurs twice in ${tz} on ${localDate} (clock change); an explicit UTC offset is required`, 400),
    };
  }
  const match = c.find((t) => offsetAt(t, tz) === o);
  if (match === undefined) {
    return { error: code("SESSION_UTC_OFFSET_MISMATCH", `The ${which} UTC offset matches neither occurrence in ${tz}`, 400) };
  }
  return { ms: match };
}

/**
 * Session start/end instants. `status` on errors: 400 for write-time validation (the caller can fix
 * the input), but attendee paths map every error to a 409 fail-closed (see checkWindow).
 * @returns {{ startMs?: number, endMs?: number, error?: {code,message,status} }}
 */
function resolveSessionInstants({ timezone, session }) {
  if (!timezone) return { error: code("ATTENDANCE_WINDOW_UNAVAILABLE", "The event has no timezone set") };
  if (!isValidIanaTimezone(timezone)) return { error: code("ATTENDANCE_WINDOW_UNAVAILABLE", "The event timezone is invalid") };
  const s = session || {};
  if (!isValidLocalDate(s.localDate) || !isValidHhmm(s.startTime) || !isValidHhmm(s.endTime)) {
    return { error: code("SESSION_TIMING_INCOMPLETE", "The session has no complete local date, start and end time") };
  }
  const endLocalDate = s.endLocalDate == null || s.endLocalDate === "" ? s.localDate : s.endLocalDate;
  if (!isValidLocalDate(endLocalDate)) {
    return { error: code("SESSION_TIMING_INCOMPLETE", "The session end date is invalid") };
  }
  const start = resolveLocalInstant({ localDate: s.localDate, time: s.startTime, tz: timezone, utcOffset: s.startUtcOffset, which: "start" });
  if (start.error) return { error: start.error };
  const end = resolveLocalInstant({ localDate: endLocalDate, time: s.endTime, tz: timezone, utcOffset: s.endUtcOffset, which: "end" });
  if (end.error) return { error: end.error };
  if (end.ms <= start.ms) {
    return {
      error: code(
        "SESSION_END_NOT_AFTER_START",
        "The session end must be after its start (an overnight session needs an explicit endLocalDate)",
        400,
      ),
    };
  }
  return { startMs: start.ms, endMs: end.ms };
}

/**
 * Write-time validation for a session's timing fields (CRM add/update session). Format errors are
 * always 400. Instant-level checks (gap / overlap / end-after-start) run only when the event has a
 * valid timezone; without one the window simply stays unavailable (fail closed at attendance time).
 * @returns {{code,message,status}|null}
 */
function validateSessionTiming(session, timezone) {
  const s = session || {};
  for (const f of ["localDate", "endLocalDate"]) {
    if (s[f] != null && s[f] !== "" && !isValidLocalDate(s[f])) return code("INVALID_SESSION_DATE", `${f} must be YYYY-MM-DD`, 400);
  }
  for (const f of ["startTime", "endTime"]) {
    if (s[f] != null && s[f] !== "" && !isValidHhmm(s[f])) return code("INVALID_SESSION_TIME", `${f} must be HH:mm`, 400);
  }
  for (const f of ["startUtcOffset", "endUtcOffset"]) {
    if (s[f] != null && s[f] !== "" && parseOffsetMinutes(s[f]) === null) return code("INVALID_UTC_OFFSET", `${f} must be +HH:MM or -HH:MM`, 400);
  }
  if (s.endLocalDate && s.localDate && isValidLocalDate(s.endLocalDate) && isValidLocalDate(s.localDate) && s.endLocalDate < s.localDate) {
    return code("SESSION_END_NOT_AFTER_START", "endLocalDate is before localDate", 400);
  }
  if (!timezone || !isValidIanaTimezone(timezone)) return null;
  if (!isValidLocalDate(s.localDate) || !isValidHhmm(s.startTime) || !isValidHhmm(s.endTime)) return null;
  const r = resolveSessionInstants({ timezone, session: s });
  return r.error && r.error.status === 400 ? r.error : null;
}

const PATHS = Object.freeze({ SELF: "self", QR_SCAN: "qr-scan", QR_MINT: "qr-mint", CRM: "crm" });

/**
 * The window for one attendee path.
 * @returns {{ opensAt?: Date, closesAt?: Date, error?: {code,message,status} }}
 */
function computeWindow({ timezone, session, path }) {
  const r = resolveSessionInstants({ timezone, session });
  if (r.error) return { error: { ...r.error, status: 409 } };
  const closeAfter = path === PATHS.SELF ? SELF_CLOSE_AFTER_MS : QR_CLOSE_AFTER_MS;
  return { opensAt: new Date(r.startMs - OPEN_BEFORE_MS), closesAt: new Date(r.endMs + closeAfter) };
}

/**
 * Attendee-path gate. QR minting may happen before the window opens (passes are issued in
 * advance) but never after it closes. Self is virtual-only.
 * @returns {{ opensAt?: Date, closesAt?: Date, error?: {code,message,status,details?} }}
 */
function checkWindow({ timezone, session, path, now = new Date() }) {
  if (path === PATHS.SELF && session?.isVirtual !== true) {
    return {
      error: code(
        "ATTENDANCE_SELF_NOT_ALLOWED_IN_PERSON",
        "Self check-in is only available for online sessions - in-person attendance is recorded by the organiser's QR scan",
      ),
    };
  }
  const w = computeWindow({ timezone, session, path });
  if (w.error) return w;
  const t = now.getTime();
  if (path !== PATHS.QR_MINT && t < w.opensAt.getTime()) {
    return { ...w, error: { ...code("ATTENDANCE_NOT_OPEN", "Attendance for this session is not open yet"), details: { opensAt: w.opensAt.toISOString() } } };
  }
  if (t > w.closesAt.getTime()) {
    return { ...w, error: { ...code("ATTENDANCE_CLOSED", "Attendance for this session has closed - please contact the organiser"), details: { closesAt: w.closesAt.toISOString() } } };
  }
  return w;
}

module.exports = {
  OPEN_BEFORE_MS,
  QR_CLOSE_AFTER_MS,
  SELF_CLOSE_AFTER_MS,
  PATHS,
  isValidIanaTimezone,
  isValidLocalDate,
  isValidHhmm,
  parseOffsetMinutes,
  offsetAt,
  localCandidates,
  resolveSessionInstants,
  validateSessionTiming,
  computeWindow,
  checkWindow,
};
