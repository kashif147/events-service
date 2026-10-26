// Event tenant authority for events-service consumers (Phase A / A2).
//
// The envelope tenant (payload.tenantId, set by the publisher from its trusted context) is canonical;
// data.tenantId is only a fallback when the envelope has none; the AMQP `x-tenant-id` header must agree
// when present. Missing, inconsistent or placeholder tenants are REJECTED. Ownership is never inferred
// from a referenced object id.
//
// Returns a result instead of throwing on purpose: a throw makes rabbitmq-middleware republish the
// message to its original exchange/routing key (3x), re-delivering it to every other bound queue.
const PLACEHOLDERS = new Set(["unknown", "default", "system", "null", "undefined"]);
const TENANT_FORMAT = /^[A-Za-z0-9._:-]{1,128}$/;
const clean = (v) => (v == null ? "" : String(v).trim());

function isValidTenantId(value) {
  const v = clean(value);
  return Boolean(v) && TENANT_FORMAT.test(v) && !PLACEHOLDERS.has(v.toLowerCase());
}

/**
 * @returns {{ ok: true, tenantId: string } | { ok: false, reason: "missing"|"mismatch"|"malformed" }}
 */
function resolveEventTenant(payload, context) {
  const envelope = clean(payload?.tenantId);
  const data =
    payload?.data && typeof payload.data === "object" ? clean(payload.data.tenantId) : "";
  const header = clean(context?.headers?.["x-tenant-id"]);
  const present = [envelope, data, header].filter(Boolean);
  if (!present.length) return { ok: false, reason: "missing" };
  if (present.some((v) => !isValidTenantId(v))) return { ok: false, reason: "malformed" };
  if (new Set(present).size > 1) return { ok: false, reason: "mismatch" };
  return { ok: true, tenantId: envelope || data || header };
}

module.exports = { resolveEventTenant, isValidTenantId };
