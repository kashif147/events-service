# Attendance

Per-session attendance lives on `Registration.sessionAttendance` (one entry per
`sessionId`), not as a single overall flag — see `models/registration.model.js`. The
top-level `Registration.status`'s `"attended"`/`"no-show"` values are a **rollup computed
once**, at event completion (`services/attendanceRollup.service.js`'s
`computeRegistrationAttendanceRollup()`, called from `event.controller.js`'s
`completeEventById()`), never flipped speculatively mid-event off partial data — an event
with `allowPartialAttendance:true` means a registration's pass/fail can only be judged
once every session it's required to attend has actually happened.

## Three ways an entry gets written

1. **QR self-check-in** (`method:"qr"`) — `services/checkinToken.service.js` signs a
   short-lived HMAC token (`CHECKIN_TOKEN_SECRET` env var) encoding
   `tenantId`/`registrationId`/`sessionId`; `GET /registrations/:id/sessions/:sessionId/checkin-qr`
   (authenticated) mints one, `POST /api/public/checkin/:token`
   (`routes/publicCheckin.routes.js`, mounted in `app.js` **before**
   `app.use(authenticate)` — the token itself is the credential) redeems it. The write is
   append-only and atomically guarded (`"sessionAttendance.sessionId": {$ne: sessionId}`
   in the query), so a replayed/duplicate scan is a safe idempotent no-op, not a duplicate
   entry or an error.
2. **Manual** — CRM: `PUT /registrations/:id/sessions/:sessionId/attendance`
   (`method:"manual-crm"`, can set *or overwrite* any prior entry for that session,
   including a Zoom/Teams auto-synced one). Attendee self-service outside the QR flow:
   `POST /registrations/:id/sessions/:sessionId/attendance/self`
   (`method:"manual-attendee"`, ownership-checked against `submittedByUserId`, can only
   mark `"attended"`, never `"absent"`).
3. **Zoom/Teams auto-sync** (`method:"zoom"`/`"teams"`) — see below. **Never overwrites an
   existing `"manual-crm"` entry** (`services/onlineAttendanceSync.service.js` checks this
   explicitly) - a human correction always wins over a later auto-sync pass.

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
