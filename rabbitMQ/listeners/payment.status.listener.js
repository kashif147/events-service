const mongoose = require("mongoose");
const Registration = require("../../models/registration.model.js");
const { resolveEventTenant } = require("../eventTenant.js");
const {
  publishRegistrationConfirmed,
} = require("../publishers/registration.events.publisher.js");

/**
 * Handles account-service's "payments.events.status.updated.v1" routing key
 * on the existing accounts.events exchange (Phase 3 adds the publish side of
 * this in account-service, mirroring how portal-service already consumes
 * accounts.events for membership application status updates).
 */
async function handlePaymentStatusUpdated(payload, context) {
  // Phase A / A2: the event tenant is required and the registration must belong to it. Ownership is
  // never inferred from registrationId alone. Rejections are logged and skipped (no throw - see
  // rabbitMQ/eventTenant.js), so nothing is mutated across tenants.
  const tenant = resolveEventTenant(payload, context);
  if (!tenant.ok) {
    console.warn("[events-service] EventTenantRejected: payment status event", {
      reason: tenant.reason,
      eventId: payload?.eventId || null,
      correlationId: payload?.correlationId || null,
    });
    return;
  }
  const tenantId = tenant.tenantId;

  const data = payload?.data || payload || {};
  const { registrationId, status } = data;
  if (!registrationId) {
    console.warn("[events-service] payment status event missing registrationId, skipping", {
      eventId: payload?.eventId || null,
    });
    return;
  }
  if (!mongoose.Types.ObjectId.isValid(String(registrationId))) {
    console.warn("[events-service] payment status event has a malformed registrationId, skipping", {
      eventId: payload?.eventId || null,
    });
    return;
  }

  const registration = await Registration.findOne({ _id: registrationId, tenantId });
  if (!registration) {
    console.warn("[events-service] EventTenantRecordMismatch: no registration for this tenant", {
      registrationId: String(registrationId),
      eventId: payload?.eventId || null,
    });
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
    // Stripe has authorized (held) the funds. Capture only ever happens via
    // an explicit PUT /:id/approve call (CRM's Add Attendee "Approve now"
    // choice, or a later manual approval from view mode) - just reflect the
    // authorization here, never auto-capture/approve from this webhook.
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
