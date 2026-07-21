const axios = require("axios");

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  "http://projectshell-vm.northeurope.cloudapp.azure.com/user-service";

const EVENT_CATEGORY_LOOKUPTYPE_CODE = "EVTCAT";

/**
 * Same pattern as services/accountService.client.js: forward the original
 * caller's gateway-verified headers (JWT/tenant/user) rather than a shared
 * secret - user-service's Lookup routes are permission-gated
 * (defaultPolicyAdapter) with no internal-request bypass, so the acting user
 * must hold lookup:read.
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
 * Fetch all "Event Category" Lookup rows (LookupType code EVTCAT) - CPD /
 * Professional Events today. GET /api/lookup returns a bare array of all
 * lookups for the tenant, not paginated/filterable server-side, so we filter
 * client-side instead.
 */
async function fetchEventCategoryLookups(req, tenantId) {
  const response = await axios.get(`${USER_SERVICE_URL}/api/lookup`, {
    headers: buildHeaders(req, tenantId),
    timeout: 15000,
  });
  const lookups = response.data || [];
  return lookups.filter(
    (l) => l.lookuptypeId?.code === EVENT_CATEGORY_LOOKUPTYPE_CODE && l.isdeleted !== true,
  );
}

/**
 * Resolve+validate an eventCategoryLookupId against live Lookup data - never
 * trust a client-supplied code, always re-resolve it server-side from the id.
 */
async function resolveEventCategoryLookup(eventCategoryLookupId, req, tenantId) {
  if (!eventCategoryLookupId) return null;

  const categories = await fetchEventCategoryLookups(req, tenantId);
  const match = categories.find((c) => String(c._id) === String(eventCategoryLookupId));

  if (!match) {
    throw new Error(`Event Category lookup "${eventCategoryLookupId}" not found for this tenant`);
  }

  return { id: match._id, code: match.code };
}

module.exports = {
  fetchEventCategoryLookups,
  resolveEventCategoryLookup,
};
