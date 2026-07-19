const mongoose = require("mongoose");

const EventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: null, maxlength: 4000 },
    productId: { type: String, default: null }, // ref into user-service Product (Event ProductType)
    productCode: { type: String, default: null },
    // The user-service ProductType this event's Product gets created under -
    // the authoritative reference (no enum: whatever real ProductType the
    // admin picked in Product Management, not a guessed/hardcoded code).
    eventCategoryProductTypeId: { type: String, default: null },
    // That ProductType's own `code` at selection time - kept for display and
    // for mapping to the correct GL income account, without a re-lookup.
    eventCategoryCode: { type: String, default: null },
    eventTypeId: { type: String, default: null }, // ref into user-service Lookup ("Event Type")
    memberPrice: { type: Number, default: null },
    nonMemberPrice: { type: Number, default: null },
    venueId: { type: String, default: null }, // ref into user-service Lookup ("Venue")
    venue: { type: String, default: null }, // display string: venue name + address
    isVirtual: { type: Boolean, default: false },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    capacity: { type: Number, default: null },
    cpdCredits: { type: Number, default: null },
    accreditationBody: { type: String, default: null },
    certificationType: { type: String, default: null },
    autoIssueOnFinish: { type: Boolean, default: true },
    costs: {
      type: [{ name: { type: String, required: true }, amount: { type: Number, default: 0 } }],
      default: [],
    },
    status: {
      type: String,
      enum: ["Draft", "Published", "Cancelled", "Completed"],
      default: "Draft",
    },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
    createdByEmail: { type: String, default: null },
    updatedBy: { type: String, default: null },
    updatedByEmail: { type: String, default: null },
  },
  { timestamps: true },
);

EventSchema.index({ tenantId: 1, status: 1, startDate: 1 });

module.exports = mongoose.model("Event", EventSchema);
