const express = require("express");
const router = express.Router();
const registrationController = require("../controllers/registration.controller.js");
const checkinController = require("../controllers/checkin.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { requireCrmUser, requireCrmOrPortalOwner } = require("../middlewares/callerClass.mw.js");

// Authorization layers (P5 portal object authorization):
//   1. caller class from the VERIFIED identity (middlewares/callerClass.mw.js):
//      - requireCrmUser: staff-only (CRM grid, approval, attendee edits, CRM
//        attendance, payment retry, duplicate lookups) - PORTAL gets 403 CRM_ONLY.
//      - requireCrmOrPortalOwner: CRM tenant-wide, or a PORTAL caller on a
//        registration they submitted (submittedByUserId == verified user id,
//        same binding as /mine) - anything else 403 NOT_OWNER.
//   2. the existing PDP permission (events:read/create/write), unchanged.
// PORTAL roles still hold events:read/create (self-service create, /mine,
// attendance/self) - holding the permission string alone no longer reaches
// any other registration or any staff operation.
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
  defaultPolicyMiddleware.requirePermission("events", "read"),
  registrationController.getMyRegistrations,
);
router.get(
  "/:id",
  requireCrmOrPortalOwner,
  defaultPolicyMiddleware.requirePermission("events", "read"),
  registrationController.getRegistrationById,
);
router.post(
  "/",
  defaultPolicyMiddleware.requirePermission("events", "create"),
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
  defaultPolicyMiddleware.requirePermission("events", "write"),
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

// Attendance - QR generation: CRM, or the attendee for their own registration;
// CRM marking: CRM only; self-marking: ownership-checked inside the controller
// against submittedByUserId (unchanged).
router.get(
  "/:id/sessions/:sessionId/checkin-qr",
  requireCrmOrPortalOwner,
  defaultPolicyMiddleware.requirePermission("events", "write"),
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
  defaultPolicyMiddleware.requirePermission("events", "read"),
  checkinController.markAttendanceSelf,
);

module.exports = router;
