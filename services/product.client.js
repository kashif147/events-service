const axios = require("axios");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/user-service";

/**
 * Same pattern as services/accountService.client.js: forward the original
 * caller's gateway-verified headers (JWT/tenant/user) rather than a shared
 * secret - user-service's Product/ProductType/Pricing routes are permission-
 * gated (defaultPolicyAdapter) with no internal-request bypass, so the acting
 * user must hold product:write/pricing:write/product-type:read.
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

async function resolveProductTypeId(req, tenantId, code) {
  const response = await axios.get(`${USER_SERVICE_URL}/api/product-types`, {
    headers: buildHeaders(req, tenantId),
    timeout: 15000,
  });
  const productTypes = response.data?.data || [];
  const match = productTypes.find((pt) => pt.code === code);
  if (!match) {
    throw new Error(`ProductType with code "${code}" not found for this tenant`);
  }
  return match._id;
}

async function findProductByCode(req, tenantId, code) {
  const response = await axios.get(`${USER_SERVICE_URL}/api/products`, {
    headers: buildHeaders(req, tenantId),
    params: { code },
    timeout: 15000,
  });
  const products = response.data?.data || [];
  return products.find((p) => p.code === String(code).toUpperCase()) || null;
}

async function createProduct(req, tenantId, { name, code, description, productTypeId, incomeAccountCode }) {
  const response = await axios.post(
    `${USER_SERVICE_URL}/api/products`,
    { name, code, description, productTypeId, incomeAccountCode },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

async function updateProduct(req, tenantId, productId, { name, description, productTypeId, incomeAccountCode }) {
  const response = await axios.put(
    `${USER_SERVICE_URL}/api/products/${productId}`,
    { name, description, productTypeId, incomeAccountCode },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

async function createPricing(req, tenantId, { productId, currency, memberPrice, nonMemberPrice, effectiveFrom, effectiveTo }) {
  const response = await axios.post(
    `${USER_SERVICE_URL}/api/pricing`,
    { productId, currency, memberPrice, nonMemberPrice, effectiveFrom, effectiveTo },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

async function getPricingByProduct(req, tenantId, productId) {
  const response = await axios.get(
    `${USER_SERVICE_URL}/api/pricing/by-product/${productId}`,
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  // Sorted effectiveFrom desc by the API - first row is the current/most recent one.
  return response.data?.data || [];
}

async function updatePricing(req, tenantId, pricingId, { memberPrice, nonMemberPrice, effectiveFrom, effectiveTo }) {
  const response = await axios.put(
    `${USER_SERVICE_URL}/api/pricing/${pricingId}`,
    { memberPrice, nonMemberPrice, effectiveFrom, effectiveTo },
    { headers: buildHeaders(req, tenantId), timeout: 15000 },
  );
  return response.data?.data;
}

module.exports = {
  resolveProductTypeId,
  findProductByCode,
  createProduct,
  updateProduct,
  createPricing,
  getPricingByProduct,
  updatePricing,
};
