const express = require("express");
const router = express.Router();
const registrationController = require("../controllers/registration.controller.js");
const checkinController = require("../controllers/checkin.controller.js");
const studentVerificationController = require("../controllers/studentVerification.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const {
  requireCrmUser,
  requireCrmOrPortalOwner,
  requireIdentifiedCrmOrPortal,
  requirePortalUser,
} = require("../middlewares/callerClass.mw.js");
const { requireRegistrationPermission } = require("../middlewares/registrationPermission.mw.js");

// Authorization layers (P5 portal object authorization):
//   1. caller class from the VERIFIED identity (middlewares/callerClass.mw.js):
//      - requireCrmUser: staff-only (CRM grid, approval, attendee edits, CRM
//        attendance, payment retry, duplicate lookups) - PORTAL gets 403 CRM_ONLY.
//      - requireCrmOrPortalOwner: CRM tenant-wide, or a PORTAL caller on a
//        registration they submitted (submittedByUserId == verified user id,
//        same binding as /mine) - anything else 403 NOT_OWNER.
//      - requireIdentifiedCrmOrPortal: self-scoped routes (create, /mine) -
//        CRM or PORTAL with a verified user id.
//      - requirePortalUser: attendance/self - PORTAL with a verified user id
//        only; CRM gets 403 PORTAL_ONLY (CRM uses PUT .../attendance).
//   2. the PDP permission:
//      - staff-only routes: events:read/create/write, unchanged.
//      - portal self-service routes: requireRegistrationPermission(action) -
//        CRM keeps events:<action>; PORTAL needs registrations:<action>
//        (TRANSITION: falls back to the legacy events:<action> - see
//        middlewares/registrationPermission.mw.js).
// Holding a permission string alone never reaches another member's
// registration or any staff operation.
router.get(
  "/",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "read"),
  registrationController.listRegistrations,
);
router.get(
  "/profile/:profileId",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "read"),
  registrationController.getRegistrationsByProfile,
);
// Literal routes below must stay registered before GET /:id, or express would
// capture their path segment as :id instead of routing to them.
// Self-scoped by construction (submittedByUserId = verified user id).
router.get(
  "/mine",
  requireIdentifiedCrmOrPortal,
  requireRegistrationPermission("read"),
  registrationController.getMyRegistrations,
);
// P5 organiser scan: the authenticated organiser (CRM + events:write, same tenant - checked in the
// controller against the pass) records presence; the pass alone never does.
router.post(
  "/checkin/scan",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  checkinController.scanCheckinToken,
);
router.get(
  "/:id",
  requireCrmOrPortalOwner,
  requireRegistrationPermission("read"),
  registrationController.getRegistrationById,
);
// PORTAL: identity (profile, registeredVia) is derived from the verified
// caller inside the controller - never from the body. CRM may target any
// profile in its tenant (existing behaviour).
router.post(
  "/",
  requireIdentifiedCrmOrPortal,
  requireRegistrationPermission("create"),
  registrationController.createRegistration,
);
// Returns other profiles' candidate matches (membership numbers, emails) -
// CRM Add Attendee drawer only; the portal never calls it.
router.post(
  "/attendee-duplicate-check",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "create"),
  registrationController.checkNewAttendeeDuplicates,
);
router.put(
  "/:id/attendee",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  registrationController.updateRegistrationAttendee,
);
router.put(
  "/:id/cancel",
  requireCrmOrPortalOwner,
  requireRegistrationPermission("write"),
  registrationController.cancelRegistration,
);
router.put(
  "/:id/approve",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  registrationController.approveRegistration,
);
// CRM-only: the portal authorizes payment against account-service BEFORE the
// registration exists (see registration-flow.md), so it never retries here.
router.post(
  "/:id/retry-payment",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  registrationController.retryRegistrationPayment,
);
router.put(
  "/:id/reject",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  registrationController.rejectRegistration,
);
// P5 STUDENT policy: CRM verify/reject of a declared student pricing claim
// (blocks approval/capture until verified; reject rejects the registration).
// Same gate as approve/reject - no new permission.
router.put(
  "/:id/student-verification",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  studentVerificationController.decideStudentVerification,
);

// Attendance - pass minting: CRM, or the attendee for their own registration
// (a pass is shown to the organiser, never self-redeemed); organiser scan:
// POST /checkin/scan above; CRM marking/correction: CRM only (reason rules +
// audit in the controller); self-marking: PORTAL only, virtual sessions only
// (CRM -> 403 PORTAL_ONLY), ownership-checked against submittedByUserId. All
// validate the session against the registration's own event and the P5 time
// window (services/attendanceEligibility.service.js).
router.get(
  "/:id/sessions/:sessionId/checkin-qr",
  requireCrmOrPortalOwner,
  requireRegistrationPermission("write"),
  checkinController.getCheckinQr,
);
router.put(
  "/:id/sessions/:sessionId/attendance",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  checkinController.markAttendanceCrm,
);
router.post(
  "/:id/sessions/:sessionId/attendance/self",
  requirePortalUser,
  // Action stays "read" (as before): PORTAL needs registrations:read.
  requireRegistrationPermission("read"),
  checkinController.markAttendanceSelf,
);

module.exports = router;
