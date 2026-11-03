# Attendance

Per-session attendance lives on `Registration.sessionAttendance` (one entry per
`sessionId`), not as a single overall flag — see `models/registration.model.js`. The
top-level `Registration.status`'s `"attended"`/`"no-show"` values are a **rollup computed
once**, at event completion (`services/attendanceRollup.service.js`'s
`computeRegistrationAttendanceRollup()`, called from `event.controller.js`'s
`completeEventById()`), never flipped speculatively mid-event off partial data — an event
with `allowPartialAttendance:true` means a registration's pass/fail can only be judged
once every session it's required to attend has actually happened.

## Ways an entry gets written

1. **Organiser QR scan** (`method:"qr-organizer"`) — `GET /registrations/:id/sessions/:sessionId/checkin-qr`
   (CRM, or a PORTAL caller for their own registration) mints a signed pass
   (`services/checkinToken.service.js`, HMAC with the **required** dedicated
   `CHECKIN_TOKEN_SECRET`; no JWT_SECRET / hard-coded fallback - `app.js` fails the boot if it
   is missing, shorter than 32 chars or equal to JWT_SECRET). The pass expires when the
   session's QR window closes and is **shown to the organiser**, who scans it:
   `POST /registrations/checkin/scan` (CRM + `events:write`; the pass's tenant must equal the
   scanner's -> else 403 `CHECKIN_TENANT_MISMATCH`). Append-only, atomically guarded, a repeat
   scan is a 200 no-op; `scannedBy` records the organiser. A pass alone is not proof of
   presence - the authenticated organiser is.
   **Retired (P5):** `POST /api/public/checkin/:token` returns 410 `CHECKIN_LINK_RETIRED` and
   writes nothing; `GET /api/public/checkin/:token` is an informational page only. Legacy
   `method:"qr"` entries still load and roll up.
2. **CRM correction** (`method:"manual-crm"`) — `PUT /registrations/:id/sessions/:sessionId/attendance`
   (CRM + `events:write`): can set or overwrite any entry, in any registration state, but
   - `reason` (<= 500 chars) is **required** when the write is outside the session's QR window
     (or the window is unavailable) or overwrites an existing entry -> else 400
     `CORRECTION_REASON_REQUIRED`; the overwritten entry is kept in `previous`, plus
     `outsideWindow` and `markedBy`;
   - the write is conditional on the entry that was read (concurrent change -> 409
     `ATTENDANCE_CHANGED_CONCURRENTLY`);
   - attended -> absent on a registration with an **issued** certificate sets
     `Certificate.reviewRequired` (`reviewReason:"ATTENDANCE_DOWNGRADED"`) - never revoked,
     status unchanged;
   - every correction (and any review flag) is audited through the transactional outbox in
     the same transaction (see "Audit delivery").
3. **Attendee self-service** (`method:"manual-attendee"`) — `POST .../attendance/self`,
   **PORTAL-only** (`requirePortalUser`; CRM -> 403 `PORTAL_ONLY`), **virtual sessions only**
   (in-person -> 409 `ATTENDANCE_SELF_NOT_ALLOWED_IN_PERSON`: the organiser scan is required),
   ownership-checked against `submittedByUserId` (403 `NOT_OWNER`), only `"attended"`, never
   overwrites; an attendee who already has an entry gets 200 regardless of the window.
4. **Zoom/Teams auto-sync** (`method:"zoom"`/`"teams"`) — see below. Not windowed (the
   provider's report is the evidence). **Never overwrites an existing `"manual-crm"` entry**.

## Time window (P5, owner-approved 2026-11-03) - `services/attendanceWindow.service.js`

Computed in the **event's stored IANA timezone** (`Event.timezone`, no default):

| Path | Opens | Closes |
|---|---|---|
| organiser QR scan | start - 30 min | end + 60 min |
| virtual self | start - 30 min | end + 15 min |
| pass minting | any time before close | end + 60 min (pass `exp`) |
| CRM correction | not windowed (reason rule above) | |

- Session instants come from `EventSession.localDate` (`YYYY-MM-DD`), optional
  `endLocalDate` (overnight sessions), and `startTime`/`endTime` (`HH:mm`). The legacy `date`
  field is **not** used: the CRM stored it as browser-local midnight in UTC, so its calendar day
  is not recoverable.
- **Fail closed (409)**, never an all-day or Europe/Dublin substitute: no/invalid event timezone
  (`ATTENDANCE_WINDOW_UNAVAILABLE`), missing localDate/startTime/endTime
  (`SESSION_TIMING_INCOMPLETE`).
- **DST**: a wall-clock time that does not exist (spring gap) is rejected
  (`SESSION_TIME_NONEXISTENT`); one that occurs twice (autumn overlap) needs an explicit
  `startUtcOffset`/`endUtcOffset` (`SESSION_TIME_AMBIGUOUS`); never silently chosen. End must
  be after start (`SESSION_END_NOT_AFTER_START`).
- No per-event overrides in v1.

## Timezone and schedule changes - explicit and audited

- `Event.timezone` is set explicitly at create (CRM pre-fills it from the tenant setting; the
  user confirms) or through `PUT /events/:id/timezone` (CRM + `events:write`). The generic
  `PUT /events/:id` refuses timezone fields (400 `USE_TIMEZONE_ENDPOINT`). A later tenant-setting
  change never moves an event's stored zone. No bulk back-fill - existing events stay fail-closed
  until a CRM user sets their zone and session dates one by one (this is the correction workflow).
- Once an event is Published or has registrations, changing the timezone, or any session's
  `localDate`/`endLocalDate`/`startTime`/`endTime`/offsets/`isVirtual`/`date` (add, update or
  delete), needs `scheduleChangeReason` (400 `SCHEDULE_CHANGE_REASON_REQUIRED`) and is audited
  (`events.session.schedule_changed.v1`) in the same transaction. An unchanged re-save needs no
  reason. Completed/Cancelled events are locked (409 `EVENT_SCHEDULE_LOCKED`).

## Audit delivery (transactional outbox)

`services/outbox.service.js` + `models/outboxEvent.model.js` (collection `outboxEvents`): the
fact is written in the **same Mongo transaction** as the change (`services/transaction.js`;
needs a replica set - Atlas everywhere, single-node replica set in tests), then relayed with a
**broker confirm** (`publisher.publishConfirmed`, exchange `events.events`, explicit routing key,
`eventId` = deterministic `eventKey`). Unconfirmed -> PENDING with backoff (1 s .. 15 min),
logged after 24 h, never dropped. At-least-once: audit-service dedupes on
`UNIQUE (tenant_id, event_id)`. Keys: `events.attendance.corrected.v1`,
`events.session.schedule_changed.v1`, `events.certificate.review_flagged.v1`.
**audit-service's bindings for these keys must be deployed before this service** - a confirm
proves the broker accepted the message, not that a queue was bound.

## Structural checks (all write/credential paths)

`services/attendanceEligibility.service.js` is the one place these live - use it for any
new attendance path rather than re-deriving them:

- both ids must be 24-hex ObjectIds -> 400 (`INVALID_REGISTRATION_ID`/`INVALID_SESSION_ID`),
  never a CastError 500;
- the session must be `{tenantId, eventId: registration.eventId, isDeleted != true}` - one
  404 for missing/deleted/other-event/other-tenant (same filter as the completion rollup,
  so `isActive:false` sessions stay markable);
- course registrations have no sessions -> 409 `ATTENDANCE_NOT_SUPPORTED`;
- attendee-side paths (self, pass minting, organiser scan) additionally require
  `isActive && approvalStatus:"approved" && status:"confirmed"` -> else 409
  `REGISTRATION_NOT_ELIGIBLE` (also refuses post-rollup `attended`/`no-show`), and for
  `event.allowPartialAttendance` with non-empty `registration.sessionIds` the session must
  be one of them -> 403 `SESSION_NOT_SELECTED` (the rollup's exact predicate), then the time
  window for that path;
- the CRM route checks only ids + course + session-belongs-to-event: staff corrections are
  allowed in any registration state (e.g. fixing a no-show after the rollup).

Passes are re-validated at scan time, not only at minting.

## Zoom/Teams online attendance — poll-only, no webhook

`models/eventSession.model.js`'s `meeting` sub-object (`provider`, `joinUrl`,
`externalMeetingId`, `organizerUpn`, `attendanceSyncStatus`) is where the
frontend's per-day "Meeting Link" field (`CreateEventDrawer.jsx`/
`ScheduleManagementDrawer.jsx`'s `zoomLink` state) actually lands — `event.controller.js`'s
`buildMeetingField()` detects Zoom vs. Teams from the pasted URL
(`services/meetingLinkParser.js`) whenever `addSession`/`updateSession` receives a
`joinUrl` field. Before this, the field existed only in frontend UI state and was silently
dropped before persistence — don't assume similar "obviously connected" UI fields
elsewhere in this app are actually wired end-to-end without checking.

`jobs/onlineAttendanceSyncSweep.js` (see `scheduled-jobs.md`) is the **only** sync
mechanism - deliberately poll-only, no public webhook receiver, since both platforms
expose a pull-based post-meeting report (Zoom's Report API, Teams' Graph
`attendanceReports`) available any time after the meeting ends, and building/securing a
webhook signature-verification endpoint for a platform with no real account to test
against here would add risk without adding capability. If a lower-latency
near-real-time signal is ever needed, that's the natural next step, not a redesign.

- **Zoom** (`services/zoomIntegration.client.js`): Server-to-Server OAuth
  (`ZOOM_ACCOUNT_ID`/`ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET`, a Zoom app with
  `report:read:admin` scope), keyed off `meeting.externalMeetingId` (the numeric id in a
  `zoom.us/j/{id}` link).
- **Teams** (`services/msGraphMeetings.client.js`): Microsoft Graph client-credentials
  (`MSGRAPH_TENANT_ID`/`MSGRAPH_CLIENT_ID`/`MSGRAPH_CLIENT_SECRET`, its own Azure AD app
  registration — deliberately **not** shared with communication-service's own Graph app/
  env vars, which serve an unrelated purpose there), keyed off `meeting.joinUrl` (Graph
  looks the meeting up via `$filter=JoinWebUrl eq '...'` — there's no separate short
  meeting id to parse out of a Teams link) plus `meeting.organizerUpn` (**not currently
  settable from the frontend** — there's no UI field for it yet; a Teams session's
  `organizerUpn` has to be set directly/via a future UI addition before its attendance can
  sync).
- Neither env-var set ends in `_API_KEY`, so neither trips the root
  `enforce-hard-rules.mjs` hook's `EXTERNAL_API_KEY_ALLOWLIST` check — keep new
  credentials named this way rather than introducing a literal `_API_KEY` suffix.

`services/onlineAttendanceSync.service.js`'s `syncSessionAttendance()` matches each
returned participant by normalized email against `Registration.attendeeSnapshot.normalizedEmail`,
computes `connectedMinutes`/`connectedPercent` against the session's scheduled duration
(`startTime`/`endTime`), and marks `"attended"` only once `connectedPercent >=
Event.attendanceMinPercent` (default 80) — writes an explicit `"absent"` entry (not just a
missing one) for every applicable confirmed registration that never showed up at all, so
the per-session record is a complete, auditable picture rather than only covering people
who joined.
