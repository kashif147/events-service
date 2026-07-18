const axios = require("axios");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/user-service";

/**
 * Resolve the current price for a product (Event/Course/EventSession) from
 * user-service's generic product/pricing catalog, applying member pricing
 * when the attendee already holds a membership number.
 */
async function getCurrentPriceForProduct(productId, { isMember = false } = {}) {
  if (!productId) return { amount: 0, currency: "eur" };

  const response = await axios.get(
    `${USER_SERVICE_URL}/api/pricing/current/${productId}`,
    { timeout: 15000, headers: { "x-internal-request": "true" } },
  );

  const pricing = response.data?.data;
  if (!pricing) return { amount: 0, currency: "eur" };

  const amount = isMember
    ? pricing.memberPrice ?? pricing.price ?? 0
    : pricing.nonMemberPrice ?? pricing.price ?? 0;

  return { amount, currency: pricing.currency || "eur" };
}

module.exports = { getCurrentPriceForProduct };
