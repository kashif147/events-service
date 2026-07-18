const express = require("express");
const router = express.Router();
const courseController = require("../controllers/course.controller.js");
const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");

router.get("/", defaultPolicyMiddleware.requirePermission("events", "read"), courseController.listCourses);
router.get("/:id", defaultPolicyMiddleware.requirePermission("events", "read"), courseController.getCourseById);
router.post("/", defaultPolicyMiddleware.requirePermission("events", "create"), courseController.createCourse);
router.put("/:id", defaultPolicyMiddleware.requirePermission("events", "write"), courseController.updateCourse);
router.delete(
  "/:id",
  defaultPolicyMiddleware.requirePermission("events", "write"),
  courseController.softDeleteCourse,
);

module.exports = router;
