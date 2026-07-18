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
    profileId: registration.profileId,
    membershipNumber: registration.membershipNumber || null,
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

async function publishCertificateIssued(certificate, registration, tenantId) {
  return publish(
    ROUTING_KEYS.CERTIFICATE_ISSUED,
    {
      certificateId: String(certificate._id),
      registrationId: String(registration._id),
      profileId: registration.profileId,
      tenantId,
      generatedLetterId: certificate.generatedLetterId,
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
