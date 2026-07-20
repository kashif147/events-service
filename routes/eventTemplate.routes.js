const express = require("express");
const router = express.Router();
const eventTemplateController = require("../controllers/eventTemplate.controller");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");

// Create a new filter template
router.post(
  "/",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventTemplateController.createTemplate,
);

// Get all filter templates for the current user
router.get(
  "/",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventTemplateController.getUserTemplates,
);

// Get default template for the current user
router.get(
  "/default",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventTemplateController.getDefaultTemplate,
);

// Get a specific template by ID
router.get(
  "/:templateId",
  defaultPolicyMiddleware.requirePermission("events", "read"),
  eventTemplateController.getTemplateById,
);

// Update a filter template
router.put(
  "/:templateId",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventTemplateController.updateTemplate,
);

// Delete a filter template
router.delete(
  "/:templateId",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  eventTemplateController.deleteTemplate,
);

module.exports = router;
