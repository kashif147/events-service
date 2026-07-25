const Registration = require("../../models/registration.model.js");
const {
  publishRegistrationConfirmed,
} = require("../publishers/registration.events.publisher.js");

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
    // Stripe has authorized (held) the funds - registration stays
    // pending_review/pending until a CRM user approves; this only updates
    // the display-facing paymentStatus so "payment authorized, awaiting
    // review" is visible before approval.
    if (registration.approvalStatus === "pending_review") {
      registration.paymentStatus = "authorized";
      await registration.save();
    }
  } else if (status === "failed") {
    registration.paymentStatus = "failed";
    await registration.save();
  }
}

module.exports = { handlePaymentStatusUpdated };
