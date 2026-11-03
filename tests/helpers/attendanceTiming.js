// P5 attendance window test fixtures: explicit event timezone + session local date/times that put
// "now" inside (or outside) the window. UTC keeps the arithmetic simple; overnight spans use an
// explicit endLocalDate, exactly as the CRM must send them.
const TZ = "UTC";

function utcParts(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return { localDate: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

/**
 * Session timing (UTC) for a session starting `startOffsetMin` minutes from now and lasting
 * `durationMin` minutes. Default: started 10 min ago, ends in 60 min -> inside every window.
 */
function sessionTiming({ startOffsetMin = -10, durationMin = 70, now = Date.now() } = {}) {
  const start = Math.floor((now + startOffsetMin * 60000) / 60000) * 60000;
  const end = start + durationMin * 60000;
  const s = utcParts(start);
  const e = utcParts(end);
  return {
    localDate: s.localDate,
    startTime: s.time,
    endTime: e.time,
    endLocalDate: e.localDate !== s.localDate ? e.localDate : null,
  };
}

module.exports = { TZ, sessionTiming };
