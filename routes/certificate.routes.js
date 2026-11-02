const express = require("express");
const router = express.Router();
const certificateController = require("../controllers/certificate.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { requireCrmUser } = require("../middlewares/callerClass.mw.js");

router.post(
  "/:registrationId/issue",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "create"),
  certificateController.issueCertificate,
);

module.exports = router;
