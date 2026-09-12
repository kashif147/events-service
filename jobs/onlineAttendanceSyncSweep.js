/**
 * Self-scheduling sweep that pulls Zoom/Teams post-meeting attendance data
 * once a session has ended - same self-scheduling setInterval shape as
 * jobs/eventCompletionSweep.js (see that file and
 * single-instance-assumptions.md).
 *
 * Deliberately poll-only, no webhook receiver: Zoom's Report API and Teams'
 * (Graph) attendance-report API are both pull endpoints available any time
 * after a meeting ends, so a periodic sweep is sufficient on its own -
 * building and securing a public webhook signature-verification endpoint for
 * a platform there's no way to test against here would add risk without
 * adding capability.
 */
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const { syncSessionAttendance } = require("../services/onlineAttendanceSync.service.js");

const INTERVAL_MS = parseInt(process.env.ONLINE_ATTENDANCE_SYNC_SWEEP_MS || String(15 * 60 * 1000), 10);
// Give the platform time to finalize its attendance report before polling -
// Zoom/Teams reports aren't always immediately available the instant a
// meeting ends.
const SYNC_GRACE_MS = parseInt(process.env.ONLINE_ATTENDANCE_SYNC_GRACE_MS || String(30 * 60 * 1000), 10);

let sweepTimer = null;

function sessionEndDateTime(session) {
  const base = new Date(session.date);
  const timeStr = session.endTime || session.startTime;
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      base.setHours(h, m, 0, 0);
    }
  }
  return base;
}

async function runOnlineAttendanceSyncSweepOnce() {
  const now = Date.now();
  const candidates = await EventSession.find({
    "meeting.provider": { $in: ["zoom", "teams"] },
    "meeting.attendanceSyncStatus": "pending",
    isDeleted: { $ne: true },
  }).limit(200);

  let synced = 0;
  for (const session of candidates) {
    const endDateTime = sessionEndDateTime(session);
    if (endDateTime.getTime() + SYNC_GRACE_MS > now) continue; // not due yet

    try {
      const event = await Event.findOne({ _id: session.eventId, tenantId: session.tenantId }).lean();
      if (!event) {
        session.meeting.attendanceSyncStatus = "failed";
        await session.save();
        continue;
      }

      await syncSessionAttendance({ event, session, tenantId: session.tenantId });
      session.meeting.attendanceSyncStatus = "synced";
      session.meeting.attendanceSyncedAt = new Date();
      await session.save();
      synced += 1;
      console.log("✅ [ONLINE_ATTENDANCE_SYNC_SWEEP] Synced session:", String(session._id));
    } catch (err) {
      // Leave status "pending" (not "failed") on a transient error (network
      // hiccup, report not ready yet) so the next sweep interval retries
      // automatically rather than giving up after one attempt.
      console.error("❌ [ONLINE_ATTENDANCE_SYNC_SWEEP] Error syncing session:", String(session._id), err.message);
    }
  }

  if (synced > 0) {
    console.log(`[ONLINE_ATTENDANCE_SYNC_SWEEP] Processed batch: ${synced} session(s) synced`);
  }
}

function startOnlineAttendanceSyncSweep() {
  if (sweepTimer) return;
  if (!process.env.RABBIT_URL || !process.env.RABBIT_URL.trim()) {
    console.warn("⚠️ [ONLINE_ATTENDANCE_SYNC_SWEEP] RABBIT_URL not set; sweep not started");
    return;
  }

  console.log(`🕐 [ONLINE_ATTENDANCE_SYNC_SWEEP] Starting interval every ${INTERVAL_MS}ms`);
  sweepTimer = setInterval(() => {
    runOnlineAttendanceSyncSweepOnce().catch((err) =>
      console.error("[ONLINE_ATTENDANCE_SYNC_SWEEP] Interval error:", err.message),
    );
  }, INTERVAL_MS);

  setTimeout(() => {
    runOnlineAttendanceSyncSweepOnce().catch((err) =>
      console.error("[ONLINE_ATTENDANCE_SYNC_SWEEP] Initial run error:", err.message),
    );
  }, 20000);
}

function stopOnlineAttendanceSyncSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  startOnlineAttendanceSyncSweep,
  stopOnlineAttendanceSyncSweep,
  runOnlineAttendanceSyncSweepOnce,
};
