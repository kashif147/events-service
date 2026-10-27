/**
 * Phase A / A15 - tenant ownership immutability (models/plugins/tenantOwnership.plugin.js).
 *
 * Rule tests run the guard functions directly; model tests run the REAL adopted models (no database:
 * a rejected write fails in middleware before any connection is needed, and `hydrate` gives an existing
 * document without a read).
 */
const mongoose = require("mongoose");
const {
  checkUpdate,
  checkBulkOps,
  PLATFORM_ACTORS,
  TENANT_IMMUTABLE,
} = require("../models/plugins/tenantOwnership.plugin");

const A = "68cbf7806080b4621d469d34"; // MULTIAUTH
const B = "6acd6119b28a863c61361ae0"; // DEVTENANTB
const PLACEHOLDERS = [null, undefined, "", "default", "unknown", "DEFAULT", " system "];

const MODELS = ["../models/registration.model", "../models/course.model", "../models/event.model", "../models/eventSession.model"];

const rejectsImmutable = (fn) => {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.code).toBe(TENANT_IMMUTABLE);
  expect(err.status).toBe(409);
};

beforeAll(() => {
  mongoose.set("bufferCommands", false);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe("update rule (guard functions)", () => {
  const q = (update, extra = {}) => () => checkUpdate({ model: "M", op: "updateOne", filter: { _id: "x", tenantId: A }, update, ...extra });

  test("$set / top-level tenantId to another tenant -> TENANT_IMMUTABLE", () => {
    rejectsImmutable(q({ $set: { tenantId: B, name: "n" } }));
    rejectsImmutable(q({ tenantId: B }));
    rejectsImmutable(q({ $set: { tenantId: B } }, { op: "updateMany" }));
    rejectsImmutable(q({ $set: { tenantId: B } }, { op: "findOneAndUpdate" }));
    // without a tenant in the filter the value cannot be verified: refused (not silently dropped)
    rejectsImmutable(() => checkUpdate({ model: "M", op: "updateOne", filter: { _id: "x" }, update: { $set: { tenantId: A } } }));
  });

  test("unset / rename / other operators on tenantId -> TENANT_IMMUTABLE", () => {
    rejectsImmutable(q({ $unset: { tenantId: "" } }));
    rejectsImmutable(q({ $rename: { tenantId: "oldTenant" } }));
    rejectsImmutable(q({ $rename: { other: "tenantId" } }));
    rejectsImmutable(q({ $push: { tenantId: B } }));
    rejectsImmutable(q({ $set: { "tenantId.x": 1 } }));
    rejectsImmutable(q([{ $set: { tenantId: B } }]));
  });

  test.each(PLACEHOLDERS)("null / placeholder tenant %p cannot replace a real tenant", (v) => {
    rejectsImmutable(q({ $set: { tenantId: v } }));
    rejectsImmutable(() => checkUpdate({ model: "M", op: "updateOne", filter: { _id: "x" }, update: { $set: { tenantId: v } } }));
  });

  test("replacement must keep the filter's tenant", () => {
    const r = (update, filter = { _id: "x", tenantId: A }) => () => checkUpdate({ model: "M", op: "replaceOne", filter, update });
    rejectsImmutable(r({ name: "no tenant" }));
    rejectsImmutable(r({ name: "n", tenantId: B }));
    rejectsImmutable(r({ name: "n", tenantId: "default" }));
    rejectsImmutable(r({ name: "n", tenantId: A }, { _id: "x" }));
    expect(r({ name: "n", tenantId: A })()).toEqual({ name: "n", tenantId: A });
  });

  test("same-value tenantId is not a change: removed from $set (upsert keeps it via $setOnInsert)", () => {
    expect(q({ $set: { tenantId: A, name: "n" } })()).toEqual({ $set: { name: "n" } });
    expect(q({ $set: { tenantId: A } })()).toEqual({});
    expect(
      checkUpdate({ model: "M", op: "findOneAndUpdate", filter: { k: 1 }, update: { $set: { tenantId: A, k: 1 } }, upsert: true })
    ).toEqual({ $set: { k: 1 }, $setOnInsert: { tenantId: A } });
  });

  test("$setOnInsert may create with the filter tenant, never another", () => {
    expect(q({ $setOnInsert: { tenantId: A }, $set: { n: 1 } }, { upsert: true })()).toEqual({ $setOnInsert: { tenantId: A }, $set: { n: 1 } });
    rejectsImmutable(q({ $setOnInsert: { tenantId: B } }, { upsert: true }));
  });

  test("ordinary updates without tenantId are untouched", () => {
    expect(q({ $set: { name: "n" }, $inc: { v: 1 } })()).toEqual({ $set: { name: "n" }, $inc: { v: 1 } });
  });

  test("bulkWrite: update / updateMany / replace cannot move ownership", () => {
    rejectsImmutable(() => checkBulkOps("M", [{ updateOne: { filter: { _id: 1, tenantId: A }, update: { $set: { tenantId: B } } } }]));
    rejectsImmutable(() => checkBulkOps("M", [{ updateMany: { filter: { tenantId: A }, update: { $unset: { tenantId: 1 } } } }]));
    rejectsImmutable(() => checkBulkOps("M", [{ replaceOne: { filter: { _id: 1, tenantId: A }, replacement: { n: 1 } } }]));
    expect(() =>
      checkBulkOps("M", [
        { insertOne: { document: { tenantId: A } } },
        { updateOne: { filter: { _id: 1 }, update: { $set: { status: "ARCHIVED" } } } },
      ])
    ).not.toThrow();
  });
});

describe("no runtime migration / provisioning bypass", () => {
  test("platform actors are recorded constants only", () => {
    expect(PLATFORM_ACTORS).toEqual({ MIGRATION: "platform:migration", PROVISIONING: "platform:provisioning" });
    expect(Object.isFrozen(PLATFORM_ACTORS)).toBe(true);
  });

  test("no option, actor value or flag disables the guard", () => {
    for (const extra of [
      { actor: PLATFORM_ACTORS.MIGRATION },
      { bypassTenantGuard: true },
      { context: { actor: PLATFORM_ACTORS.PROVISIONING } },
    ]) {
      rejectsImmutable(() =>
        checkUpdate({ model: "M", op: "updateOne", filter: { tenantId: A }, update: { $set: { tenantId: B } }, ...extra })
      );
    }
    const src = require("fs").readFileSync(require.resolve("../models/plugins/tenantOwnership.plugin"), "utf8");
    // The only executable references to the actors are the frozen constants; nothing reads req/env/options for them.
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/x-actor|headers|req\.(body|ctx|user)/);
  });
});

describe.each(MODELS)("adopted model %s", (modelPath) => {
  const Model = require(modelPath);

  test("tenantId is immutable: doc.tenantId = other; save() keeps the original", () => {
    expect(Model.schema.path("tenantId").$immutable).toBe(true);
    const doc = Model.hydrate({ _id: new mongoose.Types.ObjectId(), tenantId: A });
    doc.tenantId = B;
    expect(doc.tenantId).toBe(A);
    doc.tenantId = undefined;
    expect(doc.tenantId).toBe(A);
    expect(doc.isModified("tenantId")).toBe(false);
  });

  test("forcing it anyway (overwriteImmutable) cannot be saved", async () => {
    const doc = Model.hydrate({ _id: new mongoose.Types.ObjectId(), tenantId: A });
    doc.set("tenantId", B, { overwriteImmutable: true });
    await expect(doc.save({ validateBeforeSave: false })).rejects.toMatchObject({ code: TENANT_IMMUTABLE, status: 409 });
  });

  test("query writes that move / unset / null the tenant are rejected before the database", async () => {
    const id = new mongoose.Types.ObjectId();
    for (const run of [
      () => Model.updateOne({ _id: id, tenantId: A }, { $set: { tenantId: B } }),
      () => Model.updateMany({ tenantId: A }, { $set: { tenantId: B } }),
      () => Model.findOneAndUpdate({ _id: id, tenantId: A }, { tenantId: B }),
      () => Model.findByIdAndUpdate(id, { $unset: { tenantId: 1 } }),
      () => Model.updateOne({ _id: id, tenantId: A }, { $set: { tenantId: "default" } }),
      () => Model.replaceOne({ _id: id, tenantId: A }, { tenantId: B }),
      () => Model.findOneAndReplace({ _id: id, tenantId: A }, {}),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: TENANT_IMMUTABLE, status: 409 });
    }
  });

  test("bulkWrite cannot move ownership", async () => {
    await expect(
      Model.bulkWrite([{ updateOne: { filter: { _id: new mongoose.Types.ObjectId(), tenantId: A }, update: { $set: { tenantId: B } } } }])
    ).rejects.toMatchObject({ code: TENANT_IMMUTABLE, status: 409 });
  });
});
