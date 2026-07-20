const mongoose = require("mongoose");

const EventSessionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    label: { type: String, required: true }, // e.g. "Day 1: Opening Keynote"
    date: { type: Date, required: true },
    memberPrice: { type: Number, default: null },
    nonMemberPrice: { type: Number, default: null },
    productId: { type: String, default: null }, // per-session pricing product
    productCode: { type: String, default: null },
    capacity: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

EventSessionSchema.index({ tenantId: 1, eventId: 1 });

module.exports = mongoose.model("EventSession", EventSessionSchema);
