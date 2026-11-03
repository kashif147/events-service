// Mounted in app.js BEFORE app.use(authenticate). P5: public check-in links no longer record
// attendance. GET is an informational landing page (no pass verification, no write); POST - the
// retired self-redemption - returns 410 CHECKIN_LINK_RETIRED and writes nothing. Attendance from a
// pass is recorded only by the authenticated organiser scan (POST /registrations/checkin/scan).
const express = require("express");
const router = express.Router();
const checkinController = require("../controllers/checkin.controller.js");

router.get("/checkin/:token", checkinController.publicCheckinInfo);
router.post("/checkin/:token", checkinController.retiredPublicCheckIn);

module.exports = router;
