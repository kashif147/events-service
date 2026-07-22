const express = require("express");
const router = express.Router();
const registrationController = require("../controllers/registration.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

// "events:create"/"events:read"/"events:write" must be attached to both CRM and
// PORTAL roles in user-service (Phase 2 permission seeding) since self-service
// registration (portal, mobile) and CRM-created registrations both hit these
// same routes.
router.get(
  "/",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  registrationController.listRegistrations,
);
router.get(
  "/profile/:profileId",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  registrationController.getRegistrationsByProfile,
);
router.post(
  "/",
  defaultPolicyMiddleware.requirePermission("events", "create"),
  registrationController.createRegistration,
);
router.post(
  "/attendee-duplicate-check",
  defaultPolicyMiddleware.requirePermission("events", "create"),
  registrationController.checkNewAttendeeDuplicates,
);
router.put(
  "/:id/cancel",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  registrationController.cancelRegistration,
);

module.exports = router;
