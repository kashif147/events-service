const mongoose = require("mongoose");

const RegistrationSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    registrationType: {
      type: String,
      enum: ["event", "course"],
      required: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      default: null,
      index: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      default: null,
      index: true,
    },
    sessionIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "EventSession" },
    ],
    profileId: { type: String, required: true, index: true }, // always set - member or attendee-only profile
    membershipNumber: { type: String, default: null }, // cached; null if non-member at registration time
    isMemberAtRegistration: { type: Boolean, default: false },
    attendeeSnapshot: {
      firstName: { type: String, default: null },
      lastName: { type: String, default: null },
      email: { type: String, default: null },
      phone: { type: String, default: null },
      workLocation: { type: String, default: null },
      grade: { type: String, default: null },
    },
    amount: { type: Number, required: true, default: 0 },
    currency: { type: String, default: "eur" },
    paymentId: { type: String, default: null }, // account-service Payment._id
    paymentStatus: {
      type: String,
      enum: ["pending", "succeeded", "failed", "waived", "manual"],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      enum: ["stripe", "manual", "comp", "invoice"],
      default: "stripe",
    },
    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "attended", "no-show"],
      default: "pending",
    },
    registeredVia: {
      type: String,
      enum: ["crm", "portal", "mobile"],
      required: true,
    },
    registeredByUserId: { type: String, default: null }, // CRM staff user id, if registeredVia="crm"
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

RegistrationSchema.index(
  { tenantId: 1, eventId: 1, profileId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: "objectId" } } },
);
RegistrationSchema.index(
  { tenantId: 1, courseId: 1, profileId: 1 },
  { unique: true, partialFilterExpression: { courseId: { $type: "objectId" } } },
);
RegistrationSchema.index({ tenantId: 1, paymentId: 1 });

module.exports = mongoose.model("Registration", RegistrationSchema);
