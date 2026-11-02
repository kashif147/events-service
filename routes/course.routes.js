const express = require("express");
const router = express.Router();
const courseController = require("../controllers/course.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { requireCrmUser } = require("../middlewares/callerClass.mw.js");

router.get("/", defaultPolicyMiddleware.requirePermission("events", "read"), courseController.listCourses);
router.get("/:id", defaultPolicyMiddleware.requirePermission("events", "read"), courseController.getCourseById);
router.post("/", requireCrmUser, defaultPolicyMiddleware.requirePermission("events", "create"), courseController.createCourse);
router.put("/:id", requireCrmUser, defaultPolicyMiddleware.requirePermission("events", "write"), courseController.updateCourse);
router.delete(
  "/:id",
  requireCrmUser,
  defaultPolicyMiddleware.requirePermission("events", "write"),
  courseController.softDeleteCourse,
);

module.exports = router;
