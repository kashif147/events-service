const mongoose = require("mongoose");
const Registration = require("../../models/registration.model.js");
const { resolveEventTenant } = require("../eventTenant.js");
const {
  publishRegistrationConfirmed,
} = require("../publishers/registration.events.publisher.js");
const { studentVerificationState } = require("../../services/studentEligibility.service.js");

/**
 * Handles account-service's "payments.events.status.updated.v1" routing key
 * on the existing accounts.events exchange (Phase 3 adds the publish side of
 * this in account-service, mirroring how portal-service already consumes
 * accounts.events for membership application status updates).
 */
/**
 * True only when the event's payment is the registration's own: same account-service
 * Payment id (registration.paymentId) or same Stripe PaymentIntent
 * (registration.stripePaymentIntentId). Either key, when known on both sides, must agree;
 * with no comparable key the event is not trusted (fail closed). account-service sends
 * paymentIntentId on every payments.events.status.updated.v1 (P5); older CRM-created
 * registrations have no paymentId and rely on it.
 */
function paymentMatchesRegistration(registration, data = {}) {
  const evPaymentId = data.paymentId != null ? String(data.paymentId) : "";
  const evIntentId = data.paymentIntentId != null ? String(data.paymentIntentId) : "";
  const regPaymentId = registration.paymentId != null ? String(registration.paymentId) : "";
  const regIntentId = registration.stripePaymentIntentId ? String(registration.stripePaymentIntentId) : "";
  if (evPaymentId && regPaymentId && evPaymentId !== regPaymentId) return false;
  if (evIntentId && regIntentId && evIntentId !== regIntentId) return false;
  return Boolean(
    (evPaymentId && regPaymentId && evPaymentId === regPaymentId) ||
      (evIntentId && regIntentId && evIntentId === regIntentId),
  );
}

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

  // P5 payer binding: the status must be for THIS registration's own payment. A Payment
  // that merely carries this registrationId (another payer's intent) never changes it.
  if (!paymentMatchesRegistration(registration, data)) {
    console.warn("[events-service] PaymentRegistrationMismatch: status event is not for this registration's payment, skipping", {
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
    // P5 STUDENT policy: a capture that happened outside approval never
    // confirms a registration whose student pricing claim is unverified or
    // rejected - it stays pending for CRM follow-up.
    const studentState = studentVerificationState(registration);
    if (studentState !== "pending" && studentState !== "rejected") {
      registration.status = "confirmed";
      await registration.save();
      await publishRegistrationConfirmed(registration, registration.tenantId);
    } else {
      await registration.save();
      console.warn("[events-service] StudentVerificationUnresolvedCapture: payment succeeded outside approval; registration left pending", {
        registrationId: String(registration._id),
        eventId: payload?.eventId || null,
      });
    }
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

module.exports = { handlePaymentStatusUpdated, paymentMatchesRegistration };
