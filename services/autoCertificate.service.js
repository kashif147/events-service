// Automatic certificate issuance on event completion - called from
// event.controller.js's completeEventById, right after the status flip and
// attendance rollup. Reuses createCertificateForRegistration (the exact same
// core logic the manual CRM /certificates/:registrationId/issue route uses)
// rather than duplicating it.
const Registration = require("../models/registration.model.js");
const Certificate = require("../models/certificate.model.js");
const { createCertificateForRegistration } = require("./certificateIssuance.service.js");

// Event.certificationType is the CRM's existing 3-option picker (see
// CreateEventDrawer.jsx's "Certification Type" select) - reused directly as
// the delivery-method signal rather than adding a second, independently-
// settable field that could drift out of sync with it. "Digital Certificate"
// emails it, "Paper Certificate" only makes it available for download/print,
// "Both" does both.
function deliveryMethodFromCertificationType(certificationType) {
  if (certificationType === "Paper Certificate") return "print";
  if (certificationType === "Both") return "both";
  return "email"; // "Digital Certificate", or unset/unrecognized
}

/**
 * @param {{event: object, tenantId: string}} params
 */
async function maybeIssueCertificatesForCompletedEvent({ event, tenantId }) {
  if (!event.autoIssueOnFinish) return { issued: 0, skipped: "auto-issue disabled for this event" };
  if (!event.certificateTemplateId) {
    console.warn(
      "[events-service] autoIssueOnFinish is true but no certificateTemplateId is set - skipping auto-issuance",
      { eventId: String(event._id) },
    );
    return { issued: 0, skipped: "no certificateTemplateId configured" };
  }

  const registrations = await Registration.find({
    tenantId,
    eventId: event._id,
    isActive: true,
    status: "attended",
  });

  const deliveryMethod = deliveryMethodFromCertificationType(event.certificationType);
  const deliver = deliveryMethod === "email" || deliveryMethod === "both" ? { email: true } : undefined;

  let issued = 0;
  for (const registration of registrations) {
    try {
      const existing = await Certificate.findOne({
        tenantId,
        registrationId: registration._id,
        status: { $ne: "revoked" },
      }).lean();
      if (existing) continue; // idempotent - don't re-issue on a re-run

      await createCertificateForRegistration({
        tenantId,
        actorId: null,
        registration,
        event,
        templateId: event.certificateTemplateId,
        authHeaders: null, // triggers the internal communication-service call - no originating user here
        deliver,
      });
      issued += 1;
    } catch (err) {
      console.error("[events-service] failed to auto-issue certificate", {
        eventId: String(event._id),
        registrationId: String(registration._id),
        error: err.message,
      });
    }
  }

  return { issued };
}

module.exports = { maybeIssueCertificatesForCompletedEvent };
