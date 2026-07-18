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
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Certificate", CertificateSchema);
