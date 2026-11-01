// GET /api/templates/default is read-only: it resolves the user's default view, else the system default
// (tenant-owned first, then the transitional tenantless row), else null (= the client's built-in
// default). It used to persist a blank user view (columns: []) whenever the user had no default.
// Part 1: REAL service + controller, Template model write paths spied (all must stay unused).
// Part 2: REAL service against a throwaway mongod (MONGOD_BIN or `mongod` on PATH; skipped otherwise).
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const Template = require("../models/template.model");
const service = require("../services/eventTemplate.service");
const controller = require("../controllers/eventTemplate.controller");

jest.setTimeout(60000);

const TENANT = "68cbf7806080b4621d469d34";
const OTHER_TENANT = "68ebf0806080b4621d461ae0";
const USER = "700000000000000000000001";

const WRITE_METHODS = ["create", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate", "replaceOne", "bulkWrite", "deleteOne", "deleteMany"];
function spyWrites() {
  const spies = WRITE_METHODS.map((name) => jest.spyOn(Template, name).mockImplementation(() => { throw new Error(`write ${name}`); }));
  spies.push(jest.spyOn(Template.prototype, "save").mockImplementation(() => { throw new Error("write save"); }));
  return spies;
}
const writeCalls = (spies) => spies.reduce((n, s) => n + s.mock.calls.length, 0);
const fakeDoc = (fields) => ({ ...fields, toObject() { return { ...fields }; } });
function mockReads({ own = null, tenantDefault = null, sharedDefault = null } = {}) {
  return jest.spyOn(Template, "findOne").mockImplementation(async (q) => {
    if (q.userId) return own;
    if (q.systemDefault && q.tenantId) return tenantDefault;
    if (q.systemDefault && q.$or) return sharedDefault;
    return null;
  });
}

describe("GET /templates/default - read-only resolution (spied model)", () => {
  afterEach(() => jest.restoreAllMocks());

  test("no user default + no system default: zero writes, null (client built-in default)", async () => {
    const spies = spyWrites();
    mockReads();
    await expect(service.getDefaultTemplate(USER, TENANT)).resolves.toBeNull();
    expect(writeCalls(spies)).toBe(0);
  });

  test("no user default: returns the tenant-owned system default (preferred over the shared row)", async () => {
    const spies = spyWrites();
    const find = mockReads({
      tenantDefault: fakeDoc({ _id: "t1", tenantId: TENANT, systemDefault: true, templateType: "attendees", columns: ["a"], meta: {} }),
      sharedDefault: fakeDoc({ _id: "s1", tenantId: null, systemDefault: true, templateType: "attendees", columns: ["x"] }),
    });
    const r = await service.getDefaultTemplate(USER, TENANT, "attendees");
    expect(r).toMatchObject({ _id: "t1", isDefault: true, columns: ["a"] });
    expect(find.mock.calls[0][0]).toMatchObject({ userId: USER, isDefault: true, templateType: "attendees" });
    expect(writeCalls(spies)).toBe(0);
  });

  test("falls back to the transitional tenantless system default", async () => {
    const spies = spyWrites();
    mockReads({ sharedDefault: fakeDoc({ _id: "s1", tenantId: null, systemDefault: true, templateType: "attendees", columns: ["x"] }) });
    await expect(service.getDefaultTemplate(USER, TENANT, "attendees")).resolves.toMatchObject({ _id: "s1", isDefault: true });
    expect(writeCalls(spies)).toBe(0);
  });

  test("the user's own default view wins", async () => {
    const spies = spyWrites();
    mockReads({ own: fakeDoc({ _id: "u1", userId: USER, isDefault: true, templateType: "eventssummary", columns: ["c"] }) });
    await expect(service.getDefaultTemplate(USER, TENANT)).resolves.toMatchObject({ _id: "u1" });
    expect(writeCalls(spies)).toBe(0);
  });

  test("controller: 200 {success, data: null}; type from ?type or ?templateType", async () => {
    const spies = spyWrites();
    const find = mockReads();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const req = { user: { userType: "CRM" }, ctx: { userId: USER, tenantId: TENANT }, query: { templateType: "attendees" } };
    await controller.getDefaultTemplate(req, res, (e) => { throw e; });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: null });
    expect(find.mock.calls[0][0].templateType).toBe("attendees");
    expect(writeCalls(spies)).toBe(0);
  });
});

const mongodBin =
  process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;
if (!mongodBin) console.warn("templateDefault real-mongod tests skipped: no mongod binary (set MONGOD_BIN)");

describeDb("GET /templates/default - zero writes against a real mongod", () => {
  let mongod;
  let dbPath;
  const freePort = () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  const coll = () => mongoose.connection.db.collection("templates");
  const state = async () => JSON.stringify(await coll().find({}).sort({ _id: 1 }).toArray());

  beforeAll(async () => {
    const port = await freePort();
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-getdefault-"));
    mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try {
        await mongoose.connect(`mongodb://127.0.0.1:${port}/tpl-getdefault-test`, { serverSelectionTimeoutMS: 500 });
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (mongoose.connection.readyState !== 1) throw new Error("throwaway mongod did not start");
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) mongod.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (dbPath && dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await coll().deleteMany({});
    await coll().insertMany([
      { templateType: "attendees", tenantId: null, systemDefault: true, isDefault: false, columns: ["a", "b"], meta: { deleted: false } },
      { templateType: "attendees", tenantId: OTHER_TENANT, systemDefault: true, isDefault: false, columns: ["other"], meta: { deleted: false } },
    ]);
  });

  test("repeated GET with no user default is idempotent: no row created, no columns:[] record", async () => {
    const before = await state();
    const first = await service.getDefaultTemplate(USER, TENANT);
    const second = await service.getDefaultTemplate(USER, TENANT);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(await state()).toBe(before);
    expect(await coll().countDocuments({ columns: { $size: 0 } })).toBe(0);
  });

  test("resolves the shared default (never another tenant's) without writing", async () => {
    const before = await state();
    const r = await service.getDefaultTemplate(USER, TENANT, "attendees");
    expect(r.columns).toEqual(["a", "b"]);
    expect(String(r.tenantId)).not.toBe(OTHER_TENANT);
    expect(await state()).toBe(before);
  });
});
