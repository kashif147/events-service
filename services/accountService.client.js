const axios = require("axios");

const ACCOUNT_SERVICE_URL =
  process.env.ACCOUNT_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/account-service";

function headers(tenantId) {
  return {
    "Content-Type": "application/json",
    "x-tenant-id": tenantId,
    "x-api-key": process.env.ACCOUNTS_API_KEY,
  };
}

/**
 * Create a Stripe payment intent for an event/course registration, via
 * account-service's existing /api/payments/intents endpoint (Phase 3 extends
 * its purpose enum with "eventRegistration"/"courseRegistration" and adds
 * ledgerDomain/registrationId fields).
 */
async function createRegistrationPaymentIntent({
  tenantId,
  registrationId,
  profileId,
  membershipNumber,
  productCode,
  amount,
  currency,
  purpose,
}) {
  const response = await axios.post(
    `${ACCOUNT_SERVICE_URL}/api/payments/intents`,
    {
      tenantId,
      registrationId,
      profileId,
      // If the attendee also happens to be a member, tag memberId too so this
      // payment still surfaces in their per-member ledger view (ledgerDomain
      // still marks it as "events" revenue, not membership revenue).
      ...(membershipNumber ? { memberId: membershipNumber } : {}),
      productCode,
      amount,
      currency,
      purpose, // "eventRegistration" | "courseRegistration"
      ledgerDomain: "events",
      source: "events-service",
    },
    { headers: headers(tenantId), timeout: 15000 },
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
  tenantId,
  registrationId,
  profileId,
  membershipNumber,
  productCode,
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
      productCode,
      amount,
      currency,
      method,
    },
    { headers: headers(tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

module.exports = {
  createRegistrationPaymentIntent,
  postManualRegistrationPayment,
};
