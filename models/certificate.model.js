const mongoose = require("mongoose");

const CertificateSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    registrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Registration",
      required: true,
      index: true,
    },
    profileId: { type: String, required: true, index: true },
    issuedAt: { type: Date, default: null },
    generatedLetterId: { type: String, default: null }, // FK into communication-service's generated letter
    status: {
      type: String,
      enum: ["pending", "issued", "revoked"],
      default: "pending",
    },
    // P5: an attendance downgrade after issuance flags the certificate for staff review. It is
    // never revoked automatically and its status is not changed.
    reviewRequired: { type: Boolean, default: false },
    reviewReason: { type: String, enum: ["ATTENDANCE_DOWNGRADED", null], default: null },
    reviewFlaggedAt: { type: Date, default: null },
    reviewFlaggedBy: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Certificate", CertificateSchema);
