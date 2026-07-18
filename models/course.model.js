const mongoose = require("mongoose");

const CourseSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: null },
    productId: { type: String, default: null }, // ref into user-service Product (Course ProductType)
    productCode: { type: String, default: null },
    deliveryMode: {
      type: String,
      enum: ["online", "in-person", "blended"],
      default: "online",
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    capacity: { type: Number, default: null },
    status: {
      type: String,
      enum: ["Draft", "Published", "Cancelled", "Completed"],
      default: "Draft",
    },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

CourseSchema.index({ tenantId: 1, status: 1, startDate: 1 });

module.exports = mongoose.model("Course", CourseSchema);
