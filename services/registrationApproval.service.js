const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const {
  findOrCreateAttendeeProfile,
  getProfileMembershipNumber,
  syncAttendeeProfileFields,
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
 * Core of approval, shared by three call sites: the CRM-facing PUT
 * .../approve endpoint, createRegistration's CRM same-step auto-approve
 * (manual/comp/invoice), and the Stripe payment-status listener's
 * auto-capture-on-authorization (CRM Stripe registrations). Resolves/links/
 * creates the attendee Profile per the registration's duplicateReview
 * verdict (or an explicit reviewer decision for POTENTIAL_MATCH), captures
 * the authorized Stripe payment or posts the recorded manual/comp/invoice
 * payment to the GL, and confirms the registration.
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
  }

  let finalPaymentStatus;
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

/**
 * A registration is eligible for same-step (no separate CRM click) approval
 * only when it was entered by CRM staff AND there's no ambiguity to resolve
 * - a POTENTIAL_MATCH always needs a human to pick LINK vs CREATE_NEW.
 * Portal/mobile self-service registrations are never auto-approved,
 * regardless of duplicateReview status - they always go through CRM review.
 */
function isEligibleForAutoApproval(registration) {
  return (
    registration.registeredVia === "crm" &&
    registration.duplicateReview?.status !== "POTENTIAL_MATCH"
  );
}

module.exports = {
  claimRegistrationForApproval,
  releaseRegistrationClaim,
  finalizeRegistrationApproval,
  isEligibleForAutoApproval,
};
