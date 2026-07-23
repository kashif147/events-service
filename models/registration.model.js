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
    quantity: { type: Number, default: 1, min: 1 }, // seats/tickets booked by this single profile - sum of priceBreakdown when the CRM lineItems flow is used
    // Which pricing tier the registrant selected/qualified for - "standard"
    // resolves to member/non-member (with early bird applied automatically
    // by date, not stored separately). "mixed" means priceBreakdown spans
    // more than one tier (CRM lineItems flow) - see priceBreakdown below.
    priceCategory: {
      type: String,
      enum: ["standard", "student", "group_student", "mixed"],
      default: "standard",
    },
    // Per-tier ticket breakdown for the CRM's multi-tier purchase flow (e.g.
    // 2 at Member price + 1 at Non-member guest price in one registration).
    // Empty when the legacy single-quantity/priceCategory flow is used
    // (portal/mobile, or CRM submissions with only one tier).
    priceBreakdown: {
      type: [
        {
          tierKey: {
            type: String,
            enum: [
              "MEMBER",
              "NON_MEMBER",
              "EARLY_BIRD_MEMBER",
              "EARLY_BIRD_NON_MEMBER",
              "STUDENT",
              "GROUP_STUDENT",
            ],
            required: true,
          },
          quantity: { type: Number, required: true, min: 1 },
          unitPrice: { type: Number, required: true, min: 0 },
        },
      ],
      default: [],
    },
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
      addressLine1: { type: String, default: null },
      addressLine2: { type: String, default: null },
      townCity: { type: String, default: null },
      countyState: { type: String, default: null },
      eircode: { type: String, default: null },
      country: { type: String, default: null },
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

// isActive:true scopes uniqueness to the registration currently occupying
// this profile/event(-or-course) slot - cancelRegistration flips isActive to
// false so a cancelled registration no longer blocks re-registration (see
// migrate-registration-isActive-index.js for the index/backfill migration).
RegistrationSchema.index(
  { tenantId: 1, eventId: 1, profileId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: "objectId" }, isActive: true } },
);
RegistrationSchema.index(
  { tenantId: 1, courseId: 1, profileId: 1 },
  { unique: true, partialFilterExpression: { courseId: { $type: "objectId" }, isActive: true } },
);
RegistrationSchema.index({ tenantId: 1, paymentId: 1 });

module.exports = mongoose.model("Registration", RegistrationSchema);
