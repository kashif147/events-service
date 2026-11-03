const mongoose = require("mongoose");
const { PricingTierSchema } = require("./pricingTier.schema.js");
const { tenantOwnershipPlugin } = require("./plugins/tenantOwnership.plugin");

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
    startTime: { type: String, default: null }, // "HH:mm", time-of-day only (event timezone)
    endTime: { type: String, default: null }, // "HH:mm", time-of-day only (event timezone)
    // P5 attendance window. `date` above is NOT a reliable calendar day (the CRM stored browser-local
    // midnight as a UTC instant), so the window uses these explicit local fields only:
    localDate: { type: String, default: null }, // "YYYY-MM-DD" in the event timezone
    endLocalDate: { type: String, default: null }, // overnight sessions; null = same day as localDate
    // Only for a wall-clock time that occurs twice in the zone (DST fall-back): "+HH:MM"/"-HH:MM".
    startUtcOffset: { type: String, default: null },
    endUtcOffset: { type: String, default: null },
    isVirtual: { type: Boolean, default: false }, // per-day in-person/online, for Hybrid event format
    // Online meeting details for this day/session - this is where the
    // CreateEventDrawer/ScheduleManagementDrawer frontend's "zoomLink" field
    // actually lands now (it used to be collected in the UI and silently
    // dropped before persistence - see CreateEventDrawer.jsx's sessionPayload
    // build). Populated by CRM entry (joinUrl only) or by the Zoom/Teams
    // integration once a meeting is linked (externalMeetingId/organizerUpn),
    // and read by the attendance sync sweep (services/zoomIntegration.client.js
    // / msGraphMeetings.client.js) to know which meeting to query.
    meeting: {
      provider: { type: String, enum: ["zoom", "teams", null], default: null },
      joinUrl: { type: String, default: null },
      externalMeetingId: { type: String, default: null },
      organizerUpn: { type: String, default: null }, // Teams only - Graph API needs the organizer's UPN to look up the meeting
      attendanceSyncStatus: { type: String, enum: ["pending", "synced", "failed"], default: "pending" },
      attendanceSyncedAt: { type: Date, default: null },
    },
    memberPrice: { type: Number, default: null },
    nonMemberPrice: { type: Number, default: null },
    // Optional per-day override of the event's pricing tiers (early bird,
    // student, group student). Absent/empty defers to the event's own tiers.
    pricingTiers: { type: [PricingTierSchema], default: [] },
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

// Phase A / A15: tenantId is immutable once written (ownership cannot move between tenants).
EventSessionSchema.plugin(tenantOwnershipPlugin, { modelName: "EventSession" });

module.exports = mongoose.model("EventSession", EventSessionSchema);
