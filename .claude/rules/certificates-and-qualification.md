# Certificate auto-issuance + qualification

`controllers/certificate.controller.js`'s `issueCertificate` (manual, CRM-triggered) and
`services/autoCertificate.service.js`'s `maybeIssueCertificatesForCompletedEvent` (automatic,
called from `event.controller.js`'s `completeEventById` right after the completion status
flip and attendance rollup) both delegate to the same core function,
`services/certificateIssuance.service.js`'s `createCertificateForRegistration` — don't
duplicate the create-Certificate-doc-and-publish logic in a third place.

## Setting up a certificate template (communication-service)

`Event.certificateTemplateId` points at a communication-service `Template` document (`model/
template.model.js`) — the `.docx` merge template, uploaded through the CRM's own Templates
configuration page (`POST /api/templates/upload`), same as any gap/graduation letter template.
There's nothing certificate-specific about the upload step itself:

1. Configuration → Lookups: make sure a "Template Category" lookup value exists for
   certificates (any name — e.g. "Certificate"), parented under whichever "Template Type"
   lookup is used for Word/letter documents (`buildTemplateTypeOptions`/
   `buildTemplateCategoryOptions` in the frontend's `templateLookupHelpers.js` drive this).
2. Configuration → Templates: create a new template, pick that type/category, upload the
   `.docx` file containing the certificate's actual layout/wording.
3. Back on the event, the "Certificate Template" picker (`CreateEventDrawer.jsx`, shown once
   Auto-Issue on Finish is on) lists every non-Email template from that module
   (`services/communicationTemplatesApi.js`'s `fetchDocumentTemplates` — filters out only
   `tempolateType:"Email"`, since Template Category naming is tenant-configurable and can't be
   hard-filtered on an exact string) — picking one sets `Event.certificateTemplateId` to that
   Template's `_id`.

The docx template can reference two kinds of placeholders: whatever
`services/memberData.service.js`'s `collectMemberData` resolves (`MemberName`,
`MembershipNumber`, `DOB`, `AddressLine1`, `MembershipStatus`, `ExpiryDate`,
`OutstandingBalance`), and the event-specific ones this service adds on top — see "Merge
fields" below.

## Auto-issuance gating

Only proceeds when `Event.autoIssueOnFinish === true` **and** `Event.certificateTemplateId`
is set (the manual route takes `templateId` as a per-call request param since a CRM user
picks it each time; auto-issuance has no caller to supply one, so it has to live on the
Event, set via the Certificate Template picker above). Only issues for registrations whose
attendance rollup came out `"attended"` (`Registration.status`, computed by
`services/attendanceRollup.service.js` — see `attendance.md`), never `"no-show"`.
Idempotent: skips a registration that already has a non-`"revoked"` `Certificate`, so
re-running completion (a race between the manual `/:id/complete` endpoint and
`jobs/eventCompletionSweep.js`) never double-issues.

## Merge fields

`services/certificateIssuance.service.js`'s `buildCertificateMergeFields(event)` sends
`EventTitle`/`EventDate`/`CpdCredits`/`AccreditationBody`/`CertificationType` to
communication-service as `mergeFields`, merged on top of `collectMemberData`'s output before
the docx template is rendered — this is the only way the certificate template can say
anything about *which* event it's for, since `collectMemberData` only ever knows
profile/subscription/account fields. Add a new placeholder here (not by hardcoding it into
`collectMemberData`, which is shared by every letter type, not just certificates) if the
template needs another event-specific field.

## Manual vs. automatic communication-service call

`services/communicationService.client.js` has two functions, not one:
- `generateCertificateLetter` — the manual path, forwards the CRM user's own gateway-verified
  auth headers to communication-service's `POST /api/letters/generate`.
- `generateCertificateLetterInternal` — the automatic path, since a scheduled job has no
  originating user/request to forward headers from. Calls communication-service's
  `POST /api/letters/internal/generate` instead (`x-internal-request: true` +
  `x-tenant-id` header, no JWT), mirroring the `requireInternal()`-guarded-in-controller-body
  pattern communication-service's own `/internal/letters/*` routes already use.

`createCertificateForRegistration` picks between them based on whether `authHeaders` was
passed (truthy → manual/authenticated, `null` → internal/automatic) — don't call
`generateCertificateLetter` from the auto-issuance path, it has no real headers to forward.

## Delivery method — derived from Certification Type, not a separate field

There's no standalone delivery-method field. `services/autoCertificate.service.js`'s
`deliveryMethodFromCertificationType()` derives it directly from `Event.certificationType` —
the CRM's existing 3-option "Certification Type" picker (`CreateEventDrawer.jsx`):
`"Digital Certificate"` → email, `"Paper Certificate"` → print only, `"Both"` → both. This was
deliberately chosen over adding a second, independently-settable field that could drift out of
sync with it. Only affects the *automatic* path (the manual route's response has always just
been a download URL, unchanged) — `"email"`/`"both"` passes `deliver: {email: true, toAddress:
registration.attendeeSnapshot.email}` to `generateCertificateLetterInternal` (the attendee's own
email at signup, not re-derived from their Profile via an extra cross-service call);
`"print"`/`"both"` needs no extra backend work, the existing download-URL response already
covers it.

communication-service's letter pipeline (both `/api/letters/generate` and `/internal/generate`)
converts the merged docx to PDF via `docxPdfConversion.service.js` (the same LibreOffice step
gap/graduation letters use) before uploading/emailing it — the certificate downloaded or emailed
is a real PDF, not a Word document.

## Payload extension for the qualification consumer

`rabbitMQ/publishers/registration.events.publisher.js`'s `publishCertificateIssued` now takes
an optional 4th `event` argument and adds `eventId`/`eventTitle`/`certificationType`/
`cpdCredits`/`accreditationBody`/`issuedAt` to the `events.certificate.issued.v1` payload
(additive, same routing key — existing consumers like notification-service are unaffected).
profile-service's `certificateIssued.listener.js` (see its own `CLAUDE.md`) consumes exactly
these fields to build a `Qualification` record without ever querying this service's DB.
