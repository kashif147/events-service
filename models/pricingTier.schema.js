const mongoose = require("mongoose");

// Shared by Event and EventSession so both stay in sync. Each tier is an
// optional alternate price on top of the base memberPrice/nonMemberPrice:
// - EARLY_BIRD_MEMBER / EARLY_BIRD_NON_MEMBER: cutoffDate-bound override of
//   the matching base price.
// - STUDENT: flat price, independent of membership status.
// - GROUP_STUDENT: per-person price that only applies once a registration
//   books at least minGroupSize seats together.
const PricingTierSchema = new mongoose.Schema(
  {
    tierType: {
      type: String,
      enum: ["EARLY_BIRD_MEMBER", "EARLY_BIRD_NON_MEMBER", "STUDENT", "GROUP_STUDENT"],
      required: true,
    },
    price: { type: Number, required: true, min: 0 },
    cutoffDate: { type: Date, default: null },
    minGroupSize: { type: Number, default: null, min: 2 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true, timestamps: false },
);

module.exports = { PricingTierSchema };
