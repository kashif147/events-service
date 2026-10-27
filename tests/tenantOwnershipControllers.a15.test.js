/**
 * Phase A / A15 - create / update rules through the REAL course controller and model.
 *  - create: the owner is the trusted req.ctx tenant; a body tenantId cannot choose it.
 *  - update: `{ $set: { ...req.body } }` used to let a body tenantId move the course to another tenant;
 *    the ownership guard now answers 409 TENANT_IMMUTABLE (before the database), and a body that
 *    repeats the caller's own tenant is not a change.
 */
const mongoose = require("mongoose");
const Course = require("../models/course.model");
const { createCourse, updateCourse } = require("../controllers/course.controller");

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";

const run = async (handler, req) => {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nextErr = null;
  await handler(req, res, (e) => (nextErr = e));
  return { res, nextErr };
};

beforeAll(() => {
  mongoose.set("bufferCommands", false);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("create: owner = trusted tenant; body tenantId (another tenant / placeholder) is ignored", async () => {
  const created = [];
  jest.spyOn(Course, "create").mockImplementation(async (doc) => (created.push(doc), { _id: "c1", ...doc }));
  for (const bodyTenant of [B, "default", "unknown", null]) {
    const { res } = await run(createCourse, {
      ctx: { tenantId: A, userId: "u1" },
      body: { title: "Course", startDate: "2027-01-01", tenantId: bodyTenant },
    });
    expect(res.statusCode).toBe(201);
  }
  expect(created.map((d) => d.tenantId)).toEqual([A, A, A, A]);
});

test("update: a body tenantId of another tenant / placeholder -> 409 TENANT_IMMUTABLE, nothing written", async () => {
  const exec = jest.spyOn(mongoose.Query.prototype, "exec");
  for (const bodyTenant of [B, "default", "unknown", null]) {
    const { nextErr } = await run(updateCourse, {
      ctx: { tenantId: A, userId: "u1" },
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { title: "x", tenantId: bodyTenant },
    });
    expect(nextErr).toMatchObject({ code: "TENANT_IMMUTABLE", status: 409 });
  }
  expect(exec).toHaveBeenCalled(); // reached the query, rejected by the ownership middleware
});

test("update: repeating the caller's own tenant is not a change (removed from the update)", async () => {
  const { checkUpdate } = require("../models/plugins/tenantOwnership.plugin");
  let seenUpdate = null;
  jest.spyOn(Course, "findOneAndUpdate").mockImplementation(async (filter, update) => {
    // the same rule the model middleware applies, on the controller's real filter and update
    seenUpdate = checkUpdate({ model: "Course", op: "findOneAndUpdate", filter, update });
    return { _id: "c1", tenantId: A };
  });
  const { res, nextErr } = await run(updateCourse, {
    ctx: { tenantId: A, userId: "u1" },
    params: { id: new mongoose.Types.ObjectId().toString() },
    body: { title: "x", tenantId: A },
  });
  expect(nextErr).toBeNull();
  expect(res.statusCode).toBe(200);
  expect(seenUpdate.$set).toEqual({ title: "x", updatedBy: "u1" });
});
