/**
 * Self-scheduling sweep that auto-transitions Published events to Completed
 * once their last day/date has passed - mirrors subscription-service's
 * jobs/cancellationGraceSweep.js shape (self-scheduling setInterval, no
 * external scheduler library, no leader election - see
 * single-instance-assumptions.md, which this service is added to alongside
 * subscription-service). Reuses event.controller.js's completeEventById/
 * getLastRelevantDate so the manual /:id/complete endpoint and this sweep
 * apply identical rules and can safely race (completeEventById's status-
 * guarded update means whichever gets there first wins).
 */
const Event = require("../models/event.model.js");
const { completeEventById, getLastRelevantDate } = require("../controllers/event.controller.js");

const INTERVAL_MS = parseInt(process.env.EVENT_COMPLETION_SWEEP_MS || String(60 * 60 * 1000), 10);

let sweepTimer = null;

async function runEventCompletionSweepOnce() {
  const now = new Date();
  const candidates = await Event.find({ status: "Published", isDeleted: { $ne: true } }).limit(200);
  let completed = 0;

  for (const event of candidates) {
    try {
      const lastRelevantDate = await getLastRelevantDate(event.tenantId, event._id, event);
      if (!lastRelevantDate || new Date(lastRelevantDate) > now) continue;

      const updated = await completeEventById({ event, tenantId: event.tenantId, actorId: null, actorEmail: null });
      if (updated) {
        completed++;
        console.log("✅ [EVENT_COMPLETION_SWEEP] Completed event:", String(event._id));
      }
    } catch (err) {
      console.error("❌ [EVENT_COMPLETION_SWEEP] Error:", err.message, String(event._id));
    }
  }

  if (completed > 0) {
    console.log(`[EVENT_COMPLETION_SWEEP] Processed batch: ${completed} event(s) completed`);
  }
}

function startEventCompletionSweep() {
  if (sweepTimer) return;
  if (!process.env.RABBIT_URL || !process.env.RABBIT_URL.trim()) {
    console.warn("⚠️ [EVENT_COMPLETION_SWEEP] RABBIT_URL not set; sweep not started");
    return;
  }

  console.log(`🕐 [EVENT_COMPLETION_SWEEP] Starting interval every ${INTERVAL_MS}ms`);
  sweepTimer = setInterval(() => {
    runEventCompletionSweepOnce().catch((err) =>
      console.error("[EVENT_COMPLETION_SWEEP] Interval error:", err.message),
    );
  }, INTERVAL_MS);

  setTimeout(() => {
    runEventCompletionSweepOnce().catch((err) =>
      console.error("[EVENT_COMPLETION_SWEEP] Initial run error:", err.message),
    );
  }, 15000);
}

function stopEventCompletionSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  startEventCompletionSweep,
  stopEventCompletionSweep,
  runEventCompletionSweepOnce,
};
