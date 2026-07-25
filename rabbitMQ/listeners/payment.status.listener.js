const Registration = require("../../models/registration.model.js");
const {
  publishRegistrationConfirmed,
} = require("../publishers/registration.events.publisher.js");
const {
  claimRegistrationForApproval,
  releaseRegistrationClaim,
  finalizeRegistrationApproval,
  isEligibleForAutoApproval,
} = require("../../services/registrationApproval.service.js");

/**
 * Handles account-service's "payments.events.status.updated.v1" routing key
 * on the existing accounts.events exchange (Phase 3 adds the publish side of
 * this in account-service, mirroring how portal-service already consumes
 * accounts.events for membership application status updates).
 */
async function handlePaymentStatusUpdated(payload) {
  const data = payload?.data || payload || {};
  const { registrationId, status } = data;
  if (!registrationId) {
    console.warn("[events-service] payment status event missing registrationId, skipping", data);
    return;
  }

  const registration = await Registration.findById(registrationId);
  if (!registration) {
    console.warn("[events-service] no registration for paymentId event", { registrationId });
    return;
  }

  if (status === "succeeded") {
    // Manual-capture registrations (the normal case now - see
    // registration-flow.md) only reach "succeeded" via approveRegistration's
    // own capturePaymentIntent call, which updates the Registration directly
    // rather than waiting on this async event - so this branch only fires
    // for automatic-capture payments (there are none for events/courses
    // today, but this is left in place rather than assuming it can't happen).
    registration.paymentStatus = "succeeded";
    registration.status = "confirmed";
    await registration.save();
    await publishRegistrationConfirmed(registration, registration.tenantId);
  } else if (status === "requires_capture") {
    // Stripe has authorized (held) the funds. For an unambiguous CRM
    // registration (no potential duplicate to resolve), auto-capture and
    // confirm right away - the payer only just finished entering their card,
    // so from the CRM operator's perspective create+approve is one step.
    // Portal/mobile registrations, and any CRM one with a POTENTIAL_MATCH,
    // stay pending_review for a human to approve.
    if (registration.approvalStatus === "pending_review") {
      if (isEligibleForAutoApproval(registration)) {
        const claimed = await claimRegistrationForApproval({
          id: registration._id,
          tenantId: registration.tenantId,
        });
        if (claimed) {
          try {
            await finalizeRegistrationApproval({
              claimed,
              tenantId: registration.tenantId,
              reviewerId: registration.registeredByUserId || null,
            });
            return;
          } catch (autoApproveError) {
            await releaseRegistrationClaim({ id: claimed._id, tenantId: registration.tenantId });
            console.error(
              "[events-service] auto-capture failed, left pending_review for manual approval",
              { registrationId, error: autoApproveError.message },
            );
          }
        }
      }
      registration.paymentStatus = "authorized";
      await registration.save();
    }
  } else if (status === "failed") {
    registration.paymentStatus = "failed";
    await registration.save();
  }
}

module.exports = { handlePaymentStatusUpdated };
