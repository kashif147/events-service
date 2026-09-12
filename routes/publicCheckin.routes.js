// Mounted in app.js BEFORE app.use(authenticate) - the signed token itself is
// the credential (see services/checkinToken.service.js), the same reasoning
// /health and GET /api already get an unauthenticated pass on.
const express = require("express");
const router = express.Router();
const checkinController = require("../controllers/checkin.controller.js");

router.post("/checkin/:token", checkinController.selfCheckIn);

module.exports = router;
