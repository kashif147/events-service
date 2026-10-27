const { AppError } = require("../../errors/AppError");

/**
 * Phase A / A15 - tenant ownership immutability (minimal guard; not the Phase B provisioning framework).
 *
 * Once a tenant-owned document exists with tenantId = A, ordinary application writes can never move it
 * to another tenant, unset it, or replace it with null / a placeholder:
 *  - tenantId is `immutable: true` (native mongoose): `doc.tenantId = x; doc.save()` keeps the original,
 *    and tenantId is stripped from casted updates. A save() of an existing document whose tenantId was
 *    forced anyway (overwriteImmutable) is rejected.
 *  - query middleware (updateOne, updateMany, findOneAndUpdate/findByIdAndUpdate, replaceOne,
 *    findOneAndReplace) and model middleware (bulkWrite) reject every real change with
 *    409 TENANT_IMMUTABLE before anything reaches the database: a different value than the filter's
 *    tenant, null / placeholder values, $unset / $rename / any other operator on tenantId, pipeline
 *    updates touching tenantId, and replacements that drop or change it.
 *  - a same-value tenantId in $set (e.g. an upsert that repeats its filter tenant) is not a change: it is
 *    removed from the update. Without a tenant in the filter the value cannot be verified and is refused,
 *    except for an upsert, which keeps it as $setOnInsert (seeds only the inserted document).
 *  - $setOnInsert may set tenantId (creation), but never to a value different from the filter's tenant.
 *
 * Creation: tenantId comes from the trusted context in the callers; nothing here supplies a default.
 *
 * Migration / provisioning: the platform actors below are recorded for the reviewed platform scripts that
 * may operate below this layer (raw driver, documented pre-images). There is NO runtime bypass: no header,
 * body flag, role, claim, option or actor value disables this guard.
 */
const PLATFORM_ACTORS = Object.freeze({
  MIGRATION: "platform:migration",
  PROVISIONING: "platform:provisioning",
});

const TENANT_IMMUTABLE = "TENANT_IMMUTABLE";
const PLACEHOLDER_TENANTS = new Set(["", "default", "unknown", "system", "null", "undefined", "none"]);
const QUERY_OPS = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"];
const REPLACE_OPS = new Set(["replaceOne", "findOneAndReplace"]);

const tenantString = (v) => {
  if (v == null) return null;
  if (typeof v === "string") return v.trim();
  if (typeof v.toHexString === "function") return v.toHexString();
  return null;
};

const isPlaceholderTenant = (v) => {
  const s = tenantString(v);
  return s == null || PLACEHOLDER_TENANTS.has(s.toLowerCase());
};

/** The single tenant a filter pins (plain value or {$eq}), else null. */
const filterTenant = (filter) => {
  const t = filter && filter.tenantId;
  if (t == null) return null;
  if (typeof t === "object" && !(typeof t.toHexString === "function") && "$eq" in t) return tenantString(t.$eq);
  return tenantString(t);
};

const violation = (model, op, reason) => {
  console.warn(
    JSON.stringify({ level: "warn", message: "TenantOwnershipViolation", eventType: "tenant.ownership_violation", model, op, reason })
  );
  return new AppError("Tenant ownership cannot be changed", 409, TENANT_IMMUTABLE, { model, op, reason });
};

const touchesTenant = (obj) =>
  obj != null && typeof obj === "object" && Object.keys(obj).some((k) => k === "tenantId" || k.startsWith("tenantId."));

/**
 * A set value for tenantId must be a real tenant equal to the filter's tenant. Without a pinned filter
 * tenant the value cannot be verified, so it is refused - except for an upsert, where it only seeds the
 * inserted document ($setOnInsert) and never touches an existing one.
 */
const assertSameTenant = (value, pinned, model, op, { upsert = false } = {}) => {
  if (isPlaceholderTenant(value)) throw violation(model, op, "null_or_placeholder_tenant");
  if (pinned == null && !upsert) throw violation(model, op, "tenant_unverifiable");
  if (pinned != null && tenantString(value) !== pinned) throw violation(model, op, "tenant_change");
};

/**
 * Validates (and normalises in place) one update for a write whose filter is `filter`.
 * Throws TENANT_IMMUTABLE on any ownership change. Returns the (possibly normalised) update.
 */
const checkUpdate = ({ model, op, filter, update, upsert = false }) => {
  if (update == null) return update;
  const pinned = filterTenant(filter);

  if (Array.isArray(update)) {
    if (JSON.stringify(update).includes("tenantId")) throw violation(model, op, "pipeline_update_touches_tenant");
    return update;
  }
  if (typeof update !== "object") return update;

  const keys = Object.keys(update);
  if (REPLACE_OPS.has(op)) {
    if (!Object.prototype.hasOwnProperty.call(update, "tenantId")) throw violation(model, op, "replacement_drops_tenant");
    if (pinned == null) throw violation(model, op, "replacement_without_tenant_filter");
    assertSameTenant(update.tenantId, pinned, model, op);
    return update;
  }

  for (const key of keys) {
    if (key === "tenantId") {
      // top-level field = implicit $set
      assertSameTenant(update.tenantId, pinned, model, op, { upsert });
      const v = update.tenantId;
      delete update.tenantId;
      if (upsert && pinned == null) update.$setOnInsert = { ...(update.$setOnInsert || {}), tenantId: v };
      continue;
    }
    if (key.startsWith("tenantId.")) throw violation(model, op, "nested_tenant_path");
    if (!key.startsWith("$")) continue;
    const body = update[key];
    if (key === "$rename" && body && typeof body === "object") {
      if (touchesTenant(body) || Object.values(body).some((v) => v === "tenantId" || String(v).startsWith("tenantId.")))
        throw violation(model, op, "rename_tenant");
      continue;
    }
    if (!touchesTenant(body)) continue;
    if (key === "$setOnInsert") {
      if (Object.keys(body).some((k) => k.startsWith("tenantId."))) throw violation(model, op, "nested_tenant_path");
      assertSameTenant(body.tenantId, pinned, model, op, { upsert: true });
      continue;
    }
    if (key === "$set") {
      if (Object.keys(body).some((k) => k.startsWith("tenantId."))) throw violation(model, op, "nested_tenant_path");
      assertSameTenant(body.tenantId, pinned, model, op, { upsert });
      const v = body.tenantId;
      delete body.tenantId;
      if (Object.keys(body).length === 0) delete update.$set;
      if (upsert && pinned == null) update.$setOnInsert = { ...(update.$setOnInsert || {}), tenantId: v };
      continue;
    }
    // $unset, $inc, $push, $addToSet, $pull, $min, $max, $mul, $currentDate, ... on tenantId
    throw violation(model, op, `operator_${key.slice(1)}_on_tenant`);
  }
  return update;
};

/** Same rules for each operation of a Model.bulkWrite() call. */
const checkBulkOps = (model, ops) => {
  for (const entry of Array.isArray(ops) ? ops : []) {
    if (!entry || typeof entry !== "object") continue;
    for (const [op, spec] of Object.entries(entry)) {
      if (!spec || typeof spec !== "object") continue;
      if (op === "updateOne" || op === "updateMany") {
        checkUpdate({ model, op: `bulkWrite.${op}`, filter: spec.filter, update: spec.update, upsert: !!spec.upsert });
      } else if (op === "replaceOne") {
        checkUpdate({ model, op: "replaceOne", filter: spec.filter, update: spec.replacement });
      }
    }
  }
};

function tenantOwnershipPlugin(schema, { modelName = "unknown" } = {}) {
  const path = schema.path("tenantId");
  if (!path) throw new Error(`tenantOwnershipPlugin: ${modelName} has no tenantId path`);
  // mongoose builds the immutable setter from options.immutable, so set the option first (calling
  // path.immutable(true) alone registers a setter that never blocks).
  path.options.immutable = true;
  path.immutable(true);

  // save() of an existing document bypasses query middleware, and `doc.set(path, v, {overwriteImmutable})`
  // bypasses the immutable setter: refuse any tenantId change on an existing document here.
  schema.pre("save", function tenantOwnershipSaveGuard() {
    if (!this.isNew && this.isModified("tenantId")) throw violation(modelName, "save", "tenant_change");
  });

  schema.pre(QUERY_OPS, function tenantOwnershipQueryGuard() {
    const options = typeof this.getOptions === "function" ? this.getOptions() : {};
    checkUpdate({
      model: modelName,
      op: this.op,
      filter: this.getFilter(),
      update: this.getUpdate(),
      upsert: !!(options && options.upsert),
    });
  });

  schema.pre("bulkWrite", function tenantOwnershipBulkGuard(next, ops) {
    try {
      checkBulkOps(modelName, ops);
      next();
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  tenantOwnershipPlugin,
  checkUpdate,
  checkBulkOps,
  isPlaceholderTenant,
  PLATFORM_ACTORS,
  TENANT_IMMUTABLE,
};
