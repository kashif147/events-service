const { publisher } = require("@projectShell/rabbitmq-middleware");

const EXCHANGE = "events.events";

const ROUTING_KEYS = {
  REGISTRATION_CREATED: "events.registration.created.v1",
  REGISTRATION_CONFIRMED: "events.registration.confirmed.v1",
  REGISTRATION_CANCELLED: "events.registration.cancelled.v1",
  CERTIFICATE_ISSUED: "events.certificate.issued.v1",
};

async function publish(routingKey, data, tenantId) {
  const result = await publisher.publish(routingKey, data, {
    tenantId,
    exchange: EXCHANGE,
    routingKey,
    metadata: { service: "events-service", version: "1.0" },
  });
  if (!result.success) {
    console.error("[events-service] Failed to publish", routingKey, result.error);
  }
  return result.success;
}

function registrationPayload(registration) {
  return {
    registrationId: String(registration._id),
    tenantId: registration.tenantId,
    registrationType: registration.registrationType,
    eventId: registration.eventId ? String(registration.eventId) : null,
    courseId: registration.courseId ? String(registration.courseId) : null,
    // Null pre-approval - registrations are approval-gated now (see
    // registration-flow.md), so profileId isn't resolved until
    // approvalStatus:"approved". Consumers (audit-service,
    // communication-service) must tolerate a null profileId on
    // events.registration.created.v1 in particular.
    profileId: registration.profileId || null,
    membershipNumber: registration.membershipNumber || null,
    approvalStatus: registration.approvalStatus,
    attendeeSnapshot: registration.attendeeSnapshot,
    amount: registration.amount,
    currency: registration.currency,
    paymentMethod: registration.paymentMethod,
    paymentStatus: registration.paymentStatus,
    status: registration.status,
    registeredVia: registration.registeredVia,
  };
}

async function publishRegistrationCreated(registration, tenantId) {
  return publish(ROUTING_KEYS.REGISTRATION_CREATED, registrationPayload(registration), tenantId);
}

async function publishRegistrationConfirmed(registration, tenantId) {
  return publish(ROUTING_KEYS.REGISTRATION_CONFIRMED, registrationPayload(registration), tenantId);
}

async function publishRegistrationCancelled(registration, tenantId) {
  return publish(ROUTING_KEYS.REGISTRATION_CANCELLED, registrationPayload(registration), tenantId);
}

// `event` is optional (additive payload fields only) so this stays backward
// compatible with any caller that doesn't have the Event doc loaded.
// profile-service's certificateIssued listener uses these to build a
// Qualification record without ever querying events-service's own DB.
async function publishCertificateIssued(certificate, registration, tenantId, event) {
  return publish(
    ROUTING_KEYS.CERTIFICATE_ISSUED,
    {
      certificateId: String(certificate._id),
      registrationId: String(registration._id),
      profileId: registration.profileId,
      tenantId,
      generatedLetterId: certificate.generatedLetterId,
      issuedAt: certificate.issuedAt,
      eventId: event ? String(event._id) : null,
      eventTitle: event?.title || null,
      certificationType: event?.certificationType || null,
      cpdCredits: event?.cpdCredits ?? null,
      accreditationBody: event?.accreditationBody || null,
    },
    tenantId,
  );
}

module.exports = {
  EXCHANGE,
  ROUTING_KEYS,
  publishRegistrationCreated,
  publishRegistrationConfirmed,
  publishRegistrationCancelled,
  publishCertificateIssued,
};
