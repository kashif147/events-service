// Phase B / P4 - events-service provisioning step consumer (tenant.provisioning.step.requested.v1), against a REAL
// throwaway mongod (MONGOD_BIN or `mongod` on PATH; skipped otherwise). The broker is a stub publishConfirmed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");
const g = require("../services/tenantGridDefaults");
const StepResult = require("../models/provisioningStepResult.model");
const { handleProvisioningStepRequested, localManifest, EVENT_TYPES } = require("../rabbitMQ/listeners/provisioning.step.listener");

jest.setTimeout(60000);
const RUN = "11111111-2222-4333-8444-555555555555";
const KEY = `psk2:${RUN}:events-service:grid-system-defaults:ensure-defaults`;
const LOCAL = localManifest();
const mongodBin = process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;

describeDb("events-service P4 provisioning consumer", () => {
  let mongod;
  let dbPath;
  let tenantId;
  let published;
  const pub = async (type, data, opts) => { published.push({ type, data, opts }); return { success: true, eventId: opts.eventId }; };
  beforeAll(async () => {
    const port = await new Promise((resolve, reject) => { const srv = net.createServer(); srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); }); srv.on("error", reject); });
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "ev-p4-"));
    mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
      try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ev-p4-test`, { serverSelectionTimeoutMS: 500 }); } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (mongoose.connection.readyState !== 1) throw new Error("throwaway mongod did not start");
    await StepResult.init();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) { const exited = new Promise((r) => mongod.once("exit", r)); mongod.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    try { if (dbPath && dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  });
  beforeEach(async () => {
    const db = mongoose.connection.db;
    for (const c of ["templates", "provisioningstepresults"]) await db.collection(c).deleteMany({});
    tenantId = String(new mongoose.Types.ObjectId());
    published = [];
    jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const req = (dOver = {}, envOver = {}) => {
    const data = { runId: RUN, tenantId, stepKey: KEY, stepKeyVersion: 2, service: "events-service", component: "events-service:grid-system-defaults", action: "ensure-defaults", manifestVersion: LOCAL.version, manifestSha256: LOCAL.sha256, attempt: 1, templateKey: "standard-tenant", templateVersion: 1, ...dOver };
    return { payload: { eventId: `prov_${"a".repeat(40)}`, eventType: EVENT_TYPES.REQUESTED, tenantId: data.tenantId, data, ...envOver }, context: { headers: { "x-tenant-id": envOver.header !== undefined ? envOver.header : data.tenantId } } };
  };
  const run = (r, deps = {}) => handleProvisioningStepRequested(r.payload, r.context, { publishConfirmed: pub, ...deps });
  const tpl = () => mongoose.connection.db.collection("templates");
  const tenantRows = () => tpl().find({ tenantId }).toArray();
  const allHash = async () => crypto.createHash("md5").update(JSON.stringify(await tpl().find({}).sort({ _id: 1 }).toArray())).digest("hex");

  test("the local manifest digest is the registry pin of events-service v1", () => {
    expect(LOCAL).toEqual({ version: 1, sha256: "b6439200fb4b5ab3806647db6b25da52753e83ea8bd030a91d4f1db21dd447ca" });
  });

  test("valid request: inserts the missing attendees default for the target tenant only, answers completed with counts", async () => {
    const r = await run(req());
    expect(r).toMatchObject({ outcome: "completed", data: { insertedCount: 1, skippedCount: 0 } });
    const rows = await tenantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId, templateType: "attendees", systemDefault: true });
    expect(await tpl().countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] })).toBe(0); // never tenantless
    expect(published).toHaveLength(1);
    const p = published[0];
    expect(p.type).toBe(EVENT_TYPES.COMPLETED);
    expect(p.opts).toMatchObject({ tenantId, correlationId: KEY });
    expect(p.opts.eventId).toMatch(/^prov_[0-9a-f]{40}$/);
    expect(Object.keys(p.data).sort()).toEqual(["attempt", "component", "insertedCount", "manifestSha256", "runId", "service", "skippedCount", "stepKey", "tenantId"]); // strict payload
    expect(JSON.stringify(p)).not.toMatch(/columns|columnLabels|filters|stack|Error|eyJ|@/);
  });

  test("an existing (customised) default is skipped, never overwritten", async () => {
    await g.ensureTenantDefaults(tenantId, 1);
    await tpl().updateOne({ tenantId, templateType: "attendees" }, { $set: { columns: ["custom"], columnLabels: { custom: "Mine" } } });
    const before = await allHash();
    expect(await run(req())).toMatchObject({ outcome: "completed", data: { insertedCount: 0, skippedCount: 1 } });
    expect(await allHash()).toBe(before);
  });

  test("duplicate delivery converges: same stored result re-published (same eventId + counts), no duplicate default", async () => {
    const first = await run(req());
    const second = await run(req());
    expect(second).toMatchObject({ outcome: "completed", replay: true, eventId: first.eventId, data: first.data });
    expect(published.map((p) => [p.opts.eventId, p.data.insertedCount, p.data.skippedCount])).toEqual([[first.eventId, 1, 0], [first.eventId, 1, 0]]);
    expect(await tenantRows()).toHaveLength(1);
    expect(await StepResult.countDocuments()).toBe(1);
  });

  test("crash after the write but before publish (broker down) -> throws for redelivery; the redelivery publishes the stored result", async () => {
    await expect(run(req(), { publishConfirmed: async () => ({ success: false, error: "broker nack" }) })).rejects.toThrow(/not confirmed/);
    expect(await tenantRows()).toHaveLength(1);
    const again = await run(req());
    expect(again).toMatchObject({ outcome: "completed", replay: true, data: { insertedCount: 1, skippedCount: 0 } });
    expect(await tenantRows()).toHaveLength(1);
  });

  test("crash before the write (DB unavailable) -> throws (redelivery), nothing stored", async () => {
    await expect(run(req(), { ensureTenantDefaults: async () => { throw new Error("MongoDB is not connected"); } })).rejects.toThrow(/not connected/);
    expect(await StepResult.countDocuments()).toBe(0);
    expect(published).toHaveLength(0);
  });

  test("manifest version or hash mismatch -> failed MANIFEST_DIGEST_MISMATCH, ensureTenantDefaults NOT called, nothing written", async () => {
    const ensure = jest.fn();
    for (const over of [{ manifestSha256: "0".repeat(64) }, { manifestVersion: 2 }]) {
      await mongoose.connection.db.collection("provisioningstepresults").deleteMany({});
      published = [];
      const r = await run(req(over), { ensureTenantDefaults: ensure });
      expect(r).toMatchObject({ outcome: "failed", data: { failureCode: "MANIFEST_DIGEST_MISMATCH" } });
      expect(Object.keys(published[0].data).sort()).toEqual(["attempt", "component", "failureCode", "manifestSha256", "runId", "service", "stepKey", "tenantId"]);
    }
    expect(ensure).not.toHaveBeenCalled();
    expect(await tpl().countDocuments()).toBe(0);
  });

  test("tenant triple: envelope / data / header mismatch, placeholder or org code -> dropped, nothing written, no result", async () => {
    const other = String(new mongoose.Types.ObjectId());
    const cases = [req({}, { tenantId: other }), req({}, { header: other }), req({}, { header: "" }), req({ tenantId: "DEVTENANTB" }), req({ tenantId: "default" })];
    for (const c of cases) expect(await run(c)).toMatchObject({ outcome: "dropped", reason: expect.stringMatching(/tenant_mismatch/) });
    expect(await tpl().countDocuments()).toBe(0);
    expect(published).toHaveLength(0);
  });

  test("another service's step is ignored (no write, no result); this service's unsupported component / action -> failed STEP_ERROR", async () => {
    expect(await run(req({ service: "account-service", component: "account-service:grid-system-defaults", stepKey: `psk2:${RUN}:account-service:grid-system-defaults:ensure-defaults` }))).toMatchObject({ outcome: "ignored" });
    expect(published).toHaveLength(0);
    const ensure = jest.fn();
    const wrongComponent = await run(req({ component: "events-service:roles", stepKey: `psk2:${RUN}:events-service:roles:ensure-defaults` }), { ensureTenantDefaults: ensure });
    expect(wrongComponent).toMatchObject({ outcome: "failed", data: { failureCode: "STEP_ERROR" } });
    await mongoose.connection.db.collection("provisioningstepresults").deleteMany({});
    const wrongAction = await run(req({ action: "drop-defaults", stepKey: `psk2:${RUN}:events-service:grid-system-defaults:drop-defaults` }), { ensureTenantDefaults: ensure });
    expect(wrongAction).toMatchObject({ outcome: "failed", data: { failureCode: "STEP_ERROR" } });
    expect(ensure).not.toHaveBeenCalled();
    expect(await tpl().countDocuments()).toBe(0);
  });

  test("malformed / legacy / foreign step keys and extra or missing fields -> dropped, nothing written", async () => {
    const legacy = `${tenantId}:standard-tenant@1:events-service:events-service:grid-system-defaults`;
    const cases = [
      req({ stepKey: legacy }),
      req({ stepKeyVersion: 1 }),
      req({ stepKey: KEY.replace(RUN, "22222222-2222-4333-8444-555555555555") }),
      req({ attempt: 0 }),
      req({ extra: "x" }),
      (() => { const r = req(); delete r.payload.data.manifestSha256; return r; })(),
      { payload: { ...req().payload, eventType: "tenant.provisioning.step.completed.v1" }, context: req().context },
    ];
    for (const c of cases) expect((await run(c)).outcome).toBe("dropped");
    expect(await tpl().countDocuments()).toBe(0);
    expect(published).toHaveLength(0);
  });

  test("a ledger entry from another tenant for the same step key is never re-published to this tenant", async () => {
    await run(req());
    const other = String(new mongoose.Types.ObjectId());
    const r = await run(req({ tenantId: other }));
    expect(r).toMatchObject({ outcome: "dropped", reason: "tenant_mismatch" });
  });

  test("the result ledger is insert-only (no update / delete path)", async () => {
    await run(req());
    await expect(StepResult.updateOne({ stepKey: KEY }, { $set: { "data.insertedCount": 9 } })).rejects.toThrow(/immutable/);
    await expect(StepResult.deleteOne({ stepKey: KEY })).rejects.toThrow(/immutable/);
  });
});
