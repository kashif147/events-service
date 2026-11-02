const express = require("express");
const router = express.Router();
const eventTemplateController = require("../controllers/eventTemplate.controller");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
const { requireCrmUser } = require("../middlewares/callerClass.mw.js");

// Per-user CRM grid "Save View" templates (eventssummary etc.) - CRM-only
// data; the controller already rejects non-CRM callers, the route gate makes
// that uniform (403 CRM_ONLY) and runs it before the PDP, reads included.

// Create a new filter template
router.post(
  "/",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventTemplateController.createTemplate,
);

// Get all filter templates for the current user
router.get(
  "/",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventTemplateController.getUserTemplates,
);

// Get default template for the current user
router.get(
  "/default",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventTemplateController.getDefaultTemplate,
);

// Get a specific template by ID
router.get(
  "/:templateId",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventTemplateController.getTemplateById,
);

// Update a filter template
router.put(
  "/:templateId",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventTemplateController.updateTemplate,
);

// Delete a filter template
router.delete(
  "/:templateId",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventTemplateController.deleteTemplate,
);

module.exports = router;
