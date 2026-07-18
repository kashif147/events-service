const Course = require("../models/course.model.js");
const { AppError } = require("../errors/AppError.js");

async function listCourses(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { status, from, to, q } = req.query;

    const filter = { tenantId, isDeleted: { $ne: true } };
    if (status) filter.status = status;
    if (from || to) {
      filter.startDate = {};
      if (from) filter.startDate.$gte = new Date(from);
      if (to) filter.startDate.$lte = new Date(to);
    }
    if (q) filter.title = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const courses = await Course.find(filter).sort({ startDate: 1 }).lean();
    return res.status(200).json({ success: true, data: courses });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to list courses"));
  }
}

async function getCourseById(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const course = await Course.findOne({
      _id: req.params.id,
      tenantId,
      isDeleted: { $ne: true },
    }).lean();
    if (!course) return next(AppError.notFound("Course not found"));
    return res.status(200).json({ success: true, data: course });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to fetch course"));
  }
}

async function createCourse(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const {
      title,
      description,
      productId,
      productCode,
      deliveryMode,
      startDate,
      endDate,
      capacity,
      status,
    } = req.body || {};

    if (!title || !startDate) {
      return next(AppError.badRequest("title and startDate are required"));
    }

    const course = await Course.create({
      tenantId,
      title,
      description,
      productId,
      productCode,
      deliveryMode,
      startDate,
      endDate,
      capacity,
      status: status || "Draft",
      createdBy: userId,
      updatedBy: userId,
    });

    return res.status(201).json({ success: true, data: course });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to create course"));
  }
}

async function updateCourse(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, tenantId, isDeleted: { $ne: true } },
      { $set: { ...req.body, updatedBy: userId } },
      { new: true, runValidators: true },
    );
    if (!course) return next(AppError.notFound("Course not found"));
    return res.status(200).json({ success: true, data: course });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to update course"));
  }
}

async function softDeleteCourse(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const course = await Course.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: { isDeleted: true, isActive: false, updatedBy: userId } },
      { new: true },
    );
    if (!course) return next(AppError.notFound("Course not found"));
    return res.status(200).json({ success: true, data: course });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to delete course"));
  }
}

module.exports = {
  listCourses,
  getCourseById,
  createCourse,
  updateCourse,
  softDeleteCourse,
};
