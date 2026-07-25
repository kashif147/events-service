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
    // Nullable until CRM approval resolves/creates the attendee's Profile -
    // see duplicateReview below. Never set directly by createRegistration
    // anymore; only the /approve endpoint writes this.
    profileId: { type: String, default: null, index: true },
    membershipNumber: { type: String, default: null }, // cached; null if non-member at registration time
    isMemberAtRegistration: { type: Boolean, default: false },
    // Gates whether this registration's Profile has been created/linked and
    // its payment captured/posted yet - see events-service's approve/reject
    // endpoints. Every registration starts "pending_review" regardless of
    // source (portal/mobile/crm) or whether the caller already supplied a
    // profileId - profile creation/linking and payment capture/GL-posting
    // both happen only at approval, never at intake.
    // "processing" is a transient claim state (see the /approve endpoint's
    // atomic findOneAndUpdate guard) so two concurrent approve calls can
    // never both capture/post payment for the same registration - reverted
    // back to "pending_review" if the approve attempt fails partway through.
    approvalStatus: {
      type: String,
      enum: ["pending_review", "processing", "approved", "rejected"],
      default: "pending_review",
    },
    // Duplicate-detection verdict recorded at intake (see createRegistration)
    // and (for POTENTIAL_MATCH) resolved by a CRM reviewer at approval time.
    // Mirrors the shape of profile-service's PersonalDetails.duplicateReview,
    // but lives directly on the Registration - there's no staging collection
    // here, Profile is written to directly at approval.
    duplicateReview: {
      status: {
        type: String,
        enum: [
          "NOT_CHECKED",
          "EXACT_MATCH",
          "CONFIRMED_LINK",
          "POTENTIAL_MATCH",
          "NO_MATCH",
        ],
        default: "NOT_CHECKED",
      },
      matchedProfileId: { type: String, default: null },
      matchSummary: { type: [mongoose.Schema.Types.Mixed], default: [] },
      decisionReason: { type: String, default: null },
      reviewedBy: { type: String, default: null },
      reviewedAt: { type: Date, default: null },
    },
    attendeeSnapshot: {
      firstName: { type: String, default: null },
      lastName: { type: String, default: null },
      email: { type: String, default: null },
      phone: { type: String, default: null },
      workLocation: { type: String, default: null },
      grade: { type: String, default: null },
      // Carried here (not just the original request body) because Profile
      // creation/sync now happens at approval time, well after intake - see
      // the /approve endpoint.
      nmbiNumber: { type: String, default: null },
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
    // Stripe PaymentIntent id, captured from createRegistrationPaymentIntent's
    // response - needed to call account-service's capture/cancel-by-intent-id
    // endpoints at approve/reject time without an extra lookup.
    stripePaymentIntentId: { type: String, default: null },
    // "authorized" = Stripe funds held (capture_method:"manual"), not yet
    // captured/posted to the GL - only reachable pre-approval. "pending" for
    // manual/cash/cheque/comp means received but not yet posted to the GL
    // (see account-service's deferred-posting split) - also only pre-approval.
    paymentStatus: {
      type: String,
      enum: ["pending", "authorized", "succeeded", "failed", "waived", "manual"],
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
// profileId: {$type:"string"} is required in both partial filters now that
// profileId is nullable pre-approval - without it, Mongo's unique index
// treats every profileId:null document as colliding with every other one,
// which would 409 the second pending-review registration for the same
// event/course regardless of who the (not-yet-resolved) attendee is.
RegistrationSchema.index(
  { tenantId: 1, eventId: 1, profileId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      eventId: { $type: "objectId" },
      profileId: { $type: "string" },
      isActive: true,
    },
  },
);
RegistrationSchema.index(
  { tenantId: 1, courseId: 1, profileId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      courseId: { $type: "objectId" },
      profileId: { $type: "string" },
      isActive: true,
    },
  },
);
RegistrationSchema.index({ tenantId: 1, paymentId: 1 });

module.exports = mongoose.model("Registration", RegistrationSchema);
