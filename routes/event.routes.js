const express = require("express");
const router = express.Router();
const eventController = require("../controllers/event.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { requireCrmUser } = require("../middlewares/callerClass.mw.js");
const { eventImageUploadMw } = require("../middlewares/upload.mw.js");

// Event administration is staff-only (P5): requireCrmUser (403 CRM_ONLY for
// PORTAL/unknown callers, whatever permissions they hold) runs BEFORE the
// existing events:create/write PDP check - and before multer on the image
// route, so a non-CRM upload is never buffered. Reads stay events:read.

router.get("/", defaultPolicyMiddleware.requirePermission("events", "read"), eventController.listEvents);
router.get("/:id", defaultPolicyMiddleware.requirePermission("events", "read"), eventController.getEventById);
router.get(
  "/:id/price-quote",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventController.getEventPriceQuote,
);
router.post("/", requireCrmUser, defaultPolicyMiddleware.requirePermission("events", "create"), eventController.createEvent);
router.put("/:id", requireCrmUser, defaultPolicyMiddleware.requirePermission("events", "write"), eventController.updateEvent);
router.put(
  "/:id/unpublish",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.unpublishEvent,
);
router.put(
  "/:id/cancel",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.cancelEvent,
);
router.put(
  "/:id/complete",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.completeEvent,
);
router.delete("/:id", requireCrmUser, defaultPolicyMiddleware.requirePermission("events", "write"), eventController.softDeleteEvent);

// :id may be the literal "draft" when uploading before the event is first
// saved - the returned URL rides along in the create payload afterwards.
router.post(
  "/:id/image",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "create"),
  eventImageUploadMw,
  eventController.uploadEventImage,
);

router.post(
  "/:id/sessions",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "create"),
  eventController.addSession,
);
router.put(
  "/:id/sessions/:sessionId",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.updateSession,
);
router.delete(
  "/:id/sessions/:sessionId",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.deleteSession,
);

module.exports = router;
