const express = require("express");
const router = express.Router();
const eventController = require("../controllers/event.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { eventImageUploadMw } = require("../middlewares/upload.mw.js");

router.get("/", defaultPolicyMiddleware.requirePermission("events", "read"), eventController.listEvents);
router.get("/:id", defaultPolicyMiddleware.requirePermission("events", "read"), eventController.getEventById);
router.get(
  "/:id/price-quote",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventController.getEventPriceQuote,
);
router.post("/", defaultPolicyMiddleware.requirePermission("events", "create"), eventController.createEvent);
router.put("/:id", defaultPolicyMiddleware.requirePermission("events", "write"), eventController.updateEvent);
router.put(
  "/:id/unpublish",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.unpublishEvent,
);
router.put(
  "/:id/cancel",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.cancelEvent,
);
router.put(
  "/:id/complete",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.completeEvent,
);
router.delete("/:id", defaultPolicyMiddleware.requirePermission("events", "write"), eventController.softDeleteEvent);

// :id may be the literal "draft" when uploading before the event is first
// saved - the returned URL rides along in the create payload afterwards.
router.post(
  "/:id/image",
  defaultPolicyMiddleware.requirePermission("events", "create"),
  eventImageUploadMw,
  eventController.uploadEventImage,
);

router.post(
  "/:id/sessions",
  defaultPolicyMiddleware.requirePermission("events", "create"),
  eventController.addSession,
);
router.put(
  "/:id/sessions/:sessionId",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.updateSession,
);
router.delete(
  "/:id/sessions/:sessionId",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventController.deleteSession,
);

module.exports = router;
