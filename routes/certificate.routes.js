const express = require("express");
const router = express.Router();
const certificateController = require("../controllers/certificate.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

router.post(
  "/:registrationId/issue",
  defaultPolicyMiddleware.requirePermission("events", "create"),
  certificateController.issueCertificate,
);

module.exports = router;
