const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const {
  findOrCreateAttendeeProfile,
  getProfileMembershipNumber,
  syncAttendeeProfileFields,
  deleteAttendeeProfile,
} = require("./profileLookup.client.js");
const {
  capturePaymentIntent,
  postManualRegistrationPaymentToGL,
} = require("./accountService.client.js");
const {
  publishRegistrationConfirmed,
} = require("../rabbitMQ/publishers/registration.events.publisher.js");

/**
 * Atomically claims a pending-review registration for approval processing -
 * the {approvalStatus:"pending_review"} -> "processing" transition is what
 * makes concurrent/automatic approval attempts safe: only the caller that
 * wins this update proceeds to capture/post payment, so a Stripe charge or
 * GL entry can never be posted twice for the same registration. Returns
 * null if the registration wasn't in pending_review (already claimed,
 * approved, or rejected).
 */
async function claimRegistrationForApproval({ id, tenantId }) {
  return Registration.findOneAndUpdate(
    { _id: id, tenantId, approvalStatus: "pending_review" },
    { $set: { approvalStatus: "processing" } },
    { new: true },
  );
}

/** Releases a claim back to pending_review after a failed approval attempt. */
async function releaseRegistrationClaim({ id, tenantId }) {
  return Registration.updateOne(
    { _id: id, tenantId, approvalStatus: "processing" },
    { $set: { approvalStatus: "pending_review" } },
  ).catch(() => {});
}

/**
 * Core of approval - the CRM-facing PUT .../approve endpoint is the only
 * caller, whether that call is fired immediately (the Add Attendee drawer's
 * "Approve now" choice, right after create) or later from view mode.
 * Resolves/links/creates the attendee Profile per the registration's
 * duplicateReview verdict (or an explicit reviewer decision for
 * POTENTIAL_MATCH), captures the authorized Stripe payment or posts the
 * recorded manual/comp/invoice payment to the GL, and confirms the
 * registration.
 *
 * `claimed` must already be the result of claimRegistrationForApproval - this
 * function does not claim/re-fetch it itself, so a caller can't accidentally
 * call it without the atomicity guard in place.
 */
async function finalizeRegistrationApproval({ claimed, decision, candidateProfileId, req, tenantId, reviewerId }) {
  const review = claimed.duplicateReview || {};
  let finalProfileId = null;

  if (review.status === "CONFIRMED_LINK" || review.status === "EXACT_MATCH") {
    finalProfileId = review.matchedProfileId;
  } else if (review.status === "POTENTIAL_MATCH") {
    if (decision === "LINK") {
      if (!candidateProfileId) {
        throw AppError.badRequest("candidateProfileId is required for a LINK decision");
      }
      finalProfileId = candidateProfileId;
    } else if (decision !== "CREATE_NEW") {
      throw AppError.badRequest(
        "decision must be 'LINK' or 'CREATE_NEW' - this registration has a potential duplicate match awaiting review",
      );
    }
  }
  // NO_MATCH (or anything else) falls through with finalProfileId still
  // null - create fresh below, no ambiguity to resolve.

  const snap = claimed.attendeeSnapshot || {};
  let finalMembershipNumber = null;
  // Tracks whether THIS call created a brand-new Profile (as opposed to
  // linking an existing one) - only that case needs a compensating rollback
  // below if payment capture/posting then fails, since an existing profile
  // was never ours to delete.
  let createdFreshProfile = false;
  if (finalProfileId) {
    finalMembershipNumber = await getProfileMembershipNumber({ tenantId, profileId: finalProfileId });
    if (snap.nmbiNumber) {
      await syncAttendeeProfileFields({ tenantId, profileId: finalProfileId, nmbiNumber: snap.nmbiNumber });
    }
  } else {
    const resolved = await findOrCreateAttendeeProfile({
      tenantId,
      email: snap.email,
      firstName: snap.firstName,
      lastName: snap.lastName,
      phone: snap.phone,
      workLocation: snap.workLocation,
      grade: snap.grade,
      nmbiNumber: snap.nmbiNumber,
      addressLine1: snap.addressLine1,
      addressLine2: snap.addressLine2,
      townCity: snap.townCity,
      countyState: snap.countyState,
      eircode: snap.eircode,
      country: snap.country,
    });
    finalProfileId = resolved.profileId;
    finalMembershipNumber = resolved.membershipNumber;
    createdFreshProfile = !!resolved.created;
  }

  let finalPaymentStatus;
  try {
    if (claimed.paymentMethod === "stripe") {
      if (!claimed.stripePaymentIntentId) {
        throw AppError.conflict("This registration has no Stripe PaymentIntent to capture.");
      }
      const captureResult = await capturePaymentIntent({
        req,
        tenantId,
        paymentIntentId: claimed.stripePaymentIntentId,
        profileId: finalProfileId,
        membershipNumber: finalMembershipNumber,
      });
      if (captureResult?.status !== "succeeded") {
        throw AppError.conflict("Payment capture did not succeed - registration was not approved.");
      }
      finalPaymentStatus = "succeeded";
    } else {
      if (!claimed.paymentId) {
        throw AppError.conflict("This registration has no recorded payment to post.");
      }
      await postManualRegistrationPaymentToGL({
        req,
        tenantId,
        paymentId: claimed.paymentId,
        method: claimed.paymentMethod,
        profileId: finalProfileId,
        membershipNumber: finalMembershipNumber,
      });
      // Matches the mapping this service always used: comp -> waived,
      // manual/invoice -> manual.
      finalPaymentStatus = claimed.paymentMethod === "comp" ? "waived" : "manual";
    }
  } catch (paymentError) {
    // A brand-new attendee Profile was just created above, but payment
    // capture/posting then failed (e.g. the Stripe PaymentIntent never
    // actually got authorized) - don't leave an orphan Profile with no
    // confirmed registration behind. Best-effort: a rollback failure must
    // never mask the original payment error, and deleteAttendeeProfile
    // itself already refuses to touch anything with a membershipNumber.
    if (createdFreshProfile && finalProfileId) {
      await deleteAttendeeProfile({ tenantId, profileId: finalProfileId }).catch(() => {});
    }
    // account-service's capture conflict (axios throws directly on the 409 -
    // capturePaymentIntent above is a thin unwrapped client call) reports the
    // PaymentIntent's live Stripe status in error.response.data.details.
    // stripeStatus - most commonly "canceled" because Stripe auto-releases an
    // uncaptured manual-capture authorization hold a few days after it was
    // created, which can easily happen if a registration sits pending_review
    // past that window. claimed.paymentStatus was "authorized" going into
    // this capture attempt; left uncorrected here it stays stale at
    // "authorized" forever, which hides the problem from the CRM drawer (its
    // stripePaymentNotAuthorized gate/Retry Payment UI - see
    // CreateAttendeeDrawer.jsx - only fires off paymentStatus) and every
    // future Approve attempt fails identically with "PaymentIntent cannot be
    // captured from status canceled" and no visible way to fix it.
    const stripeStatus = paymentError?.response?.data?.details?.stripeStatus;
    if (claimed.paymentMethod === "stripe" && stripeStatus && stripeStatus !== "requires_capture") {
      claimed.paymentStatus = stripeStatus === "succeeded" ? "succeeded" : "failed";
      await claimed.save().catch(() => {});
      // Give the CRM user a concrete next step instead of a bare Stripe
      // status string, if we can safely rewrite the upstream message that
      // appErrorFromUpstream (registration.controller.js) will surface.
      if (paymentError?.response?.data && stripeStatus === "canceled") {
        paymentError.response.data.message =
          "The card authorization for this registration has expired (Stripe releases uncaptured holds after several days) - use Retry Payment on this attendee to charge a new card, then Approve again.";
      }
    }
    throw paymentError;
  }

  claimed.profileId = finalProfileId;
  claimed.membershipNumber = finalMembershipNumber;
  claimed.paymentStatus = finalPaymentStatus;
  claimed.status = "confirmed";
  claimed.approvalStatus = "approved";
  claimed.duplicateReview = {
    ...review,
    status:
      review.status === "POTENTIAL_MATCH" ? (decision === "LINK" ? "CONFIRMED_LINK" : "NO_MATCH") : review.status,
    matchedProfileId: finalProfileId,
    reviewedBy: reviewerId || null,
    reviewedAt: new Date(),
  };
  await claimed.save();

  await publishRegistrationConfirmed(claimed, tenantId);

  return claimed;
}

module.exports = {
  claimRegistrationForApproval,
  releaseRegistrationClaim,
  finalizeRegistrationApproval,
};
