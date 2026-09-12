# Scheduled jobs — self-scheduling, single-instance only

`app.js` starts two self-scheduling jobs inside the `if (process.env.RABBIT_URL)` block,
chained after `setupConsumers()` resolves — the exact shape subscription-service's
`jobs/cancellationGraceSweep.js` uses (self-scheduling `setInterval`, no external
scheduler library, an initial run after a short delay, then a fixed interval).

## `jobs/eventCompletionSweep.js`

`startEventCompletionSweep()` (`EVENT_COMPLETION_SWEEP_MS`, default 1 hour). Finds
`Published` events whose last relevant date (latest `EventSession.date`, or
`Event.endDate` if the event has no sessions) has passed and transitions them to
`Completed` via `event.controller.js`'s `completeEventById()` — the same function the
manual `PUT /:id/complete` endpoint calls, so both apply identical rules and can safely
race (the underlying update is guarded on `status:"Published"`, so whichever gets there
first wins and the other is a no-op). `completeEventById` also applies the attendance
rollup (`services/attendanceRollup.service.js`) to every confirmed registration at this
point — see `attendance.md`.

## `jobs/onlineAttendanceSyncSweep.js`

`startOnlineAttendanceSyncSweep()` (`ONLINE_ATTENDANCE_SYNC_SWEEP_MS`, default 15 min;
`ONLINE_ATTENDANCE_SYNC_GRACE_MS`, default 30 min after a session's scheduled end before
polling it, giving Zoom/Teams time to finalize their own report). Finds `EventSession`
docs with `meeting.provider` set to `"zoom"`/`"teams"` and `meeting.attendanceSyncStatus:
"pending"` whose scheduled end has passed the grace period, and calls
`services/onlineAttendanceSync.service.js`'s `syncSessionAttendance()` — see
`attendance.md` for the Zoom/Teams client setup this depends on. Deliberately poll-only
(no webhook receiver) — see that job file's header comment for why.

Neither job runs at all without `RABBIT_URL` configured — there's no separate
enable/disable flag. To run either standalone (e.g. local testing without RabbitMQ), call
its exported `run*Once()` function directly instead of relying on `app.js`'s wiring.

**Single-instance assumption**: both are plain in-process schedulers with no leader
election — see `backend/.claude/rules/single-instance-assumptions.md`. Running multiple
instances of this service means every instance runs both sweeps redundantly (harmless for
`eventCompletionSweep` - its update is idempotent/status-guarded; for
`onlineAttendanceSyncSweep`, two instances could both pick up the same "pending" session
in the same tick and call the Zoom/Teams API twice for it - wasted API calls and a
redundant but idempotent DB write, not a correctness bug, since the second write just
overwrites with the same computed result).
