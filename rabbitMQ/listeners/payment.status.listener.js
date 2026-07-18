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
    registration.paymentStatus = "succeeded";
    registration.status = "confirmed";
    await registration.save();
    await publishRegistrationConfirmed(registration, registration.tenantId);
  } else if (status === "failed") {
    registration.paymentStatus = "failed";
    await registration.save();
  }
}

module.exports = { handlePaymentStatusUpdated };
