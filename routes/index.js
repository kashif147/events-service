const router = require("express").Router();

router.use("/events", require("./event.routes"));
router.use("/courses", require("./course.routes"));
router.use("/registrations", require("./registration.routes"));
router.use("/certificates", require("./certificate.routes"));

module.exports = router;
