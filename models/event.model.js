const mongoose = require("mongoose");

const EventSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: null },
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
    imageUrl: { type: String, default: null },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    capacity: { type: Number, default: null },
    // Refund window: number of days before startDate up to which a refund is
    // allowed. 0 = no refunds. Mandatory at the controller level (see
    // createEvent) rather than schema-required, to match the other
    // application-enforced-mandatory fields and avoid breaking existing
    // records/programmatic writes.
    refundPolicyDays: { type: Number, default: null, min: 0 },
    cpdCredits: { type: Number, default: null },
    accreditationBody: { type: String, default: null },
    certificationType: { type: String, default: null },
    autoIssueOnFinish: { type: Boolean, default: true },
    // Multi-day only: whether attendees may register for a subset of days
    // (true) or must register for every day (false, default).
    allowPartialAttendance: { type: Boolean, default: false },
    // Multi-day only, and only meaningful when allowPartialAttendance is
    // true: whether each day carries its own memberPrice/nonMemberPrice (on
    // its EventSession) rather than one price for the whole event.
    perDayPricing: { type: Boolean, default: false },
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
