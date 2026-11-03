const axios = require("axios");
const { AppError } = require("../errors/AppError.js");

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
 * P5 bound payment commands (S2, b5 payment-mutation contract section 3).
 * `ACCOUNT_PAYMENT_COMMAND_MODE=bound` sends capture / cancel / manual record / manual post /
 * manual void as the bound internal command: internal-only headers (never authorization,
 * x-jwt-verified, x-auth-source or x-user-*), a body naming the registration and the transition,
 * actorUserId as audit metadata only, and a deterministic Idempotency-Key. Default `legacy` sends
 * exactly today's requests, so events can deploy before account-service understands the command
 * (contract 8.3: account S1 first, then flip the mode).
 */
const TENANT_ID_RE = /^[a-f0-9]{24}$/i;
const SERVICE_NAME = "events-service";

function paymentCommandMode() {
  return String(process.env.ACCOUNT_PAYMENT_COMMAND_MODE || "legacy").trim().toLowerCase() === "bound"
    ? "bound"
    : "legacy";
}

/** Gateway URLs strip x-internal-request, so the bound command must use the in-network host. */
function internalAccountBase() {
  let host = null;
  try {
    const u = new URL(process.env.ACCOUNT_SERVICE_URL);
    if (u.protocol === "http:" || u.protocol === "https:") host = u.hostname;
  } catch {
    host = null;
  }
  if (!host || (host.includes(".") && host !== "127.0.0.1")) {
    throw new AppError(
      "Account service is not configured for internal payment commands.",
      503,
      "ACCOUNT_INTERNAL_URL_REQUIRED",
    );
  }
  return process.env.ACCOUNT_SERVICE_URL.replace(/\/$/, "");
}

function buildInternalCommandHeaders(req, tenantId) {
  const tenant = tenantId ? String(tenantId) : "";
  if (!TENANT_ID_RE.test(tenant)) {
    throw new AppError("A verified tenant is required for a payment command.", 400, "TENANT_REQUIRED");
  }
  const headers = {
    "Content-Type": "application/json",
    "x-internal-request": "true",
    "x-tenant-id": tenant,
  };
  const correlationId = req?.correlationId || req?.headers?.["x-correlation-id"];
  if (correlationId) headers["x-correlation-id"] = String(correlationId);
  return headers;
}

function registrationPurpose(registrationType) {
  return registrationType === "course" ? "courseRegistration" : "eventRegistration";
}

/**
 * command = { registrationId, registrationType, actorUserId, reason, paymentId? }.
 * Returns account's data, normalised so `status` keeps the meaning the call sites already read.
 */
async function sendBoundCommand({ path, transition, req, tenantId, command, extra = {} }) {
  const registrationId = command?.registrationId ? String(command.registrationId) : "";
  const actorUserId = command?.actorUserId ? String(command.actorUserId) : "";
  if (!registrationId) {
    throw new AppError("registrationId is required for a payment command.", 400, "PAYMENT_BINDING_REQUIRED");
  }
  if (!actorUserId) throw new AppError("A verified actor is required for a payment command.", 400, "ACTOR_REQUIRED");
  if (!command?.reason) throw new AppError("A reason is required for a payment command.", 400, "REASON_REQUIRED");
  const base = internalAccountBase();
  const headers = buildInternalCommandHeaders(req, tenantId);
  const paymentId = command.paymentId ? String(command.paymentId) : null;
  if (paymentId) headers["Idempotency-Key"] = `${SERVICE_NAME}:${transition}:${registrationId}:${paymentId}`;

  const body = {
    binding: {
      domain: "registration",
      registrationId,
      purpose: registrationPurpose(command.registrationType),
      ...(paymentId ? { paymentId } : {}),
    },
    transition,
    reason: command.reason,
    actorUserId,
    ...extra,
  };
  let response;
  try {
    response = await axios.post(`${base}${path}`, body, { headers, timeout: 15000 });
  } catch (error) {
    if (error?.response && error.response.status < 500) throw error; // 4xx: appErrorFromUpstream maps it
    // Network failure / 5xx: account state unknown - callers keep their own state unchanged.
    throw new AppError(`Payment ${transition} unavailable. Nothing was recorded; retry the action.`, 503, "ACCOUNT_UNAVAILABLE");
  }
  const data = { ...(response.data?.data || {}) };
  if (!data.status) {
    if (transition === "capture" && (data.captured || data.alreadyCaptured)) data.status = "succeeded";
    if (transition === "cancel" && (data.canceled || data.alreadyCanceled)) data.status = "canceled";
  }
  if (transition === "manual_record" && !data.paymentId && data.id) data.paymentId = data.id;
  return data;
}

function linkOf(profileId, membershipNumber) {
  if (!profileId) return {};
  return { link: { profileId: String(profileId), ...(membershipNumber ? { memberId: String(membershipNumber) } : {}) } };
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
  command = null,
}) {
  if (paymentCommandMode() === "bound") {
    return sendBoundCommand({
      path: "/api/journal/events/manual-payment",
      transition: "manual_record",
      req,
      tenantId,
      command: { ...command, registrationId, paymentId: null },
      extra: {
        record: {
          amount,
          currency,
          method,
          ...(productCode ? { productCode } : {}),
          ...(eventCategoryCode ? { eventCategoryCode } : {}),
        },
        ...linkOf(profileId, membershipNumber),
      },
    });
  }
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
async function capturePaymentIntent({ req, tenantId, paymentIntentId, profileId, membershipNumber, command = null }) {
  if (paymentCommandMode() === "bound") {
    return sendBoundCommand({
      path: `/api/payments/intents/${encodeURIComponent(paymentIntentId)}/capture`,
      transition: "capture",
      req,
      tenantId,
      command,
      extra: linkOf(profileId, membershipNumber),
    });
  }
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
async function cancelPaymentIntent({ req, tenantId, paymentIntentId, command = null }) {
  if (paymentCommandMode() === "bound") {
    return sendBoundCommand({
      path: `/api/payments/intents/${encodeURIComponent(paymentIntentId)}/cancel`,
      transition: "cancel",
      req,
      tenantId,
      command,
    });
  }
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/payments/intents/${paymentIntentId}/cancel`,
    {},
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Looks up an existing Payment by Stripe PaymentIntent id - used to verify a
 * portal/mobile-supplied stripePaymentIntentId (see createRegistration)
 * actually exists, belongs to this tenant, and to check its live amount/
 * status before trusting it, rather than blindly linking an arbitrary
 * caller-supplied id.
 */
async function getPaymentByPaymentIntentId({ req, tenantId, paymentIntentId }) {
  const response = await axios.get(
    `${ACCOUNT_SERVICE_URL}/api/payments/by-stripe/${paymentIntentId}`,
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Attaches registrationId/productCode/eventCategoryCode to a Payment whose
 * PaymentIntent portal/mobile already created (and the payer already
 * confirmed/authorized) directly against account-service, BEFORE this
 * Registration existed - so those fields couldn't be included at PaymentIntent
 * creation time. Used instead of createRegistrationPaymentIntent for
 * registeredVia portal/mobile - never create a second PaymentIntent for a
 * payment the payer already authorized.
 */
async function attachRegistrationToPaymentIntent({
  req,
  tenantId,
  paymentIntentId,
  registrationId,
  productCode,
  eventCategoryCode,
}) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/payments/intents/${paymentIntentId}/attach-registration`,
    {
      registrationId,
      ...(productCode ? { productCode } : {}),
      ...(eventCategoryCode ? { eventCategoryCode } : {}),
    },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

/**
 * Posts a previously-recorded (deferPosting) manual/comp/invoice event
 * payment to the GL, at CRM approval time, once profileId is resolved.
 */
async function postManualRegistrationPaymentToGL({ req, tenantId, paymentId, method, profileId, membershipNumber, command = null }) {
  if (paymentCommandMode() === "bound") {
    return sendBoundCommand({
      path: "/api/journal/events/manual-payment/post",
      transition: "manual_post",
      req,
      tenantId,
      command: { ...command, paymentId },
      extra: linkOf(profileId, membershipNumber),
    });
  }
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
async function voidManualRegistrationPayment({ req, tenantId, paymentId, command = null }) {
  if (paymentCommandMode() === "bound") {
    return sendBoundCommand({
      path: "/api/journal/events/manual-payment/void",
      transition: "manual_void",
      req,
      tenantId,
      command: { ...command, paymentId },
    });
  }
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
  getPaymentByPaymentIntentId,
  attachRegistrationToPaymentIntent,
  postManualRegistrationPaymentToGL,
  voidManualRegistrationPayment,
  paymentCommandMode,
};
