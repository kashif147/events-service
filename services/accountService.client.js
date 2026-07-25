const axios = require("axios");

const ACCOUNT_SERVICE_URL =
  process.env.ACCOUNT_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/account-service";

/**
 * Same pattern as profile-service/services/account.service.client.js: forward
 * the original caller's gateway-verified headers (JWT/tenant/user) rather
 * than a shared secret - there is no API-key convention anywhere in this
 * codebase for service-to-service calls, only x-internal-request plus
 * forwarded auth context (or forwarded headers when there is an originating
 * user request, which registration creation always has).
 */
function buildHeaders(req, tenantId) {
  const headers = {
    "Content-Type": "application/json",
    "x-tenant-id": tenantId || req?.headers?.["x-tenant-id"] || "",
    "x-internal-request": "true",
  };

  if (req?.headers?.authorization) headers.authorization = req.headers.authorization;
  if (req?.headers?.["x-jwt-verified"]) headers["x-jwt-verified"] = req.headers["x-jwt-verified"];
  if (req?.headers?.["x-auth-source"]) headers["x-auth-source"] = req.headers["x-auth-source"];
  if (req?.headers?.["x-user-id"]) headers["x-user-id"] = req.headers["x-user-id"];
  if (req?.headers?.["x-user-email"]) headers["x-user-email"] = req.headers["x-user-email"];
  if (req?.headers?.["x-user-type"]) headers["x-user-type"] = req.headers["x-user-type"];
  if (req?.headers?.["x-user-roles"]) headers["x-user-roles"] = req.headers["x-user-roles"];
  if (req?.headers?.["x-user-permissions"]) headers["x-user-permissions"] = req.headers["x-user-permissions"];

  const correlationId = req?.correlationId || req?.headers?.["x-correlation-id"];
  if (correlationId) headers["x-correlation-id"] = String(correlationId);

  return headers;
}

/**
 * Create a Stripe payment intent for an event/course registration, via
 * account-service's existing /api/payments/intents endpoint (Phase 3 extends
 * its purpose enum with "eventRegistration"/"courseRegistration" and adds
 * ledgerDomain/registrationId fields).
 */
async function createRegistrationPaymentIntent({
  req,
  tenantId,
  registrationId,
  profileId,
  membershipNumber,
  productCode,
  eventCategoryCode,
  amount,
  currency,
  purpose,
}) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/payments/intents`,
    {
      tenantId,
      registrationId,
      // profileId is undefined at intake for a not-yet-resolved attendee
      // (registrations are approval-gated - see registration-flow.md) -
      // account-service automatically requests manual capture for
      // eventRegistration/courseRegistration purposes regardless, and
      // profileId gets attached later via capturePaymentIntent's linkFields
      // at approval, right before the charge is actually captured.
      profileId,
      // If the attendee also happens to be a member, tag memberId too so this
      // payment still surfaces in their per-member ledger view (ledgerDomain
      // still marks it as "events" revenue, not membership revenue).
      ...(membershipNumber ? { memberId: membershipNumber } : {}),
      // account-service's zCreateIntent declares these z.string().optional() -
      // that accepts undefined but rejects a literal null (400), and events
      // without a synced Product legitimately have productCode/eventCategoryCode
      // as null (see resolveProductMetadata/resolveAmount) - omit rather than
      // send null.
      ...(productCode ? { productCode } : {}),
      // Event Category code (CPD | EVENT) - lets account-service resolve the
      // GL income account directly, decoupled from the synced Product record.
      ...(eventCategoryCode ? { eventCategoryCode } : {}),
      amount,
      currency,
      purpose, // "eventRegistration" | "courseRegistration"
      ledgerDomain: "events",
      source: "events-service",
    },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Post a manual (comp/invoice/manual) event/course payment directly to the GL,
 * without a Stripe charge - via account-service's new events-domain manual
 * posting endpoint (added in Phase 3, see account-service journal.controller.js
 * postManualEventPayment()).
 */
async function postManualRegistrationPayment({
  req,
  tenantId,
  registrationId,
  profileId,
  membershipNumber,
  productCode,
  eventCategoryCode,
  amount,
  currency,
  method, // "comp" | "manual" | "invoice"
}) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/journal/events/manual-payment`,
    {
      tenantId,
      registrationId,
      profileId,
      ...(membershipNumber ? { memberId: membershipNumber } : {}),
      // Same null-vs-undefined caveat as createRegistrationPaymentIntent -
      // omit rather than send a literal null.
      ...(productCode ? { productCode } : {}),
      ...(eventCategoryCode ? { eventCategoryCode } : {}),
      amount,
      currency,
      method,
    },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Captures a previously-authorized (capture_method:"manual") Stripe
 * PaymentIntent, at CRM approval time - attaches profileId/memberId first
 * (via account-service's capturePaymentIntent linkFields) so the resulting
 * GL entry is correctly attributed to the just-resolved attendee Profile.
 */
async function capturePaymentIntent({ req, tenantId, paymentIntentId, profileId, membershipNumber }) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/payments/intents/${paymentIntentId}/capture`,
    {
      ...(profileId ? { profileId } : {}),
      ...(membershipNumber ? { memberId: membershipNumber } : {}),
    },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Cancels (releases the hold on) a previously-authorized Stripe
 * PaymentIntent, on CRM rejection - no refund, since nothing was captured.
 */
async function cancelPaymentIntent({ req, tenantId, paymentIntentId }) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/payments/intents/${paymentIntentId}/cancel`,
    {},
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Posts a previously-recorded (deferPosting) manual/comp/invoice event
 * payment to the GL, at CRM approval time, once profileId is resolved.
 */
async function postManualRegistrationPaymentToGL({ req, tenantId, paymentId, method, profileId, membershipNumber }) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/journal/events/manual-payment/post`,
    {
      tenantId,
      paymentId,
      method,
      profileId,
      ...(membershipNumber ? { memberId: membershipNumber } : {}),
    },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Voids a recorded-but-unposted manual/comp/invoice event payment, on CRM
 * rejection - nothing was posted to the GL, so this is a plain status flip.
 */
async function voidManualRegistrationPayment({ req, tenantId, paymentId }) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/journal/events/manual-payment/void`,
    { tenantId, paymentId },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

module.exports = {
  createRegistrationPaymentIntent,
  postManualRegistrationPayment,
  capturePaymentIntent,
  cancelPaymentIntent,
  postManualRegistrationPaymentToGL,
  voidManualRegistrationPayment,
};
