"use strict";
// Phase 1A adoption — events-service tenant-context guard (WARN MODE).
// Native node:test (CommonJS) — independent of the existing Jest suite.
// Run: node --test tests/tenantContext.adoption.node.js
// (named *.node.js — not *.test.js — so the service's Jest glob does not collect it)
//
// events-service establishes trusted identity/tenant in a GLOBAL `authenticate`
// (app.js). The guard is mounted once, globally, right after it:
//   app.use(authenticate); app.use(tenantContextWarn); app.use("/api", routes)
// Ordering: authenticate -> tenantContextWarn -> requirePermission -> handler.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "events-tenantctx-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const test = require("node:test");
const assert = require("node:assert");
const policyMw = require("@membership/policy-middleware");
const { tenantContextMiddleware, resolveTenantContext } = policyMw;
const { tenantContextWarn } = require("../middlewares/tenantContext.mw.js");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const TRUSTED = "68cbf7806080b4621d469d34";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa";

const appSrc = () => read("app.js");
const routeSrc = (f) => read(path.join("routes", f));
const routeCount = (f) => (routeSrc(f).match(/router\.(get|post|put|patch|delete)\(/g) || []).length;
const permCount = (f) => (routeSrc(f).match(/requirePermission/g) || []).length;

function gatewayReq(o = {}) {
  return {
    method: "GET",
    url: "/api/events",
    originalUrl: "/api/events",
    headers: {
      "x-jwt-verified": "true",
      "x-auth-source": "gateway",
      "x-user-id": "U1",
      "x-tenant-id": TRUSTED,
      ...(o.headers || {}),
    },
    ctx: o.ctx !== undefined ? o.ctx : { tenantId: TRUSTED, userId: "U1" },
    tenantId: o.tenantId,
    body: o.body,
    query: o.query,
    params: o.params,
  };
}
function mkRes() {
  const r = { statusCode: null, _s: [] };
  r.status = (c) => ((r.statusCode = c), r._s.push(c), r);
  r.json = () => r;
  return r;
}
function run(req) {
  const res = mkRes();
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (s) => (chunks.push(typeof s === "string" ? s : s.toString()), true);
  let n = 0;
  try {
    tenantContextWarn(req, res, () => (n += 1));
  } finally {
    process.stdout.write = orig;
  }
  const rows = chunks
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { req, res, nextCount: n, rows };
}

// ---- static structure ----
test("1 tenantContextWarn exists (exported, callable)", () => {
  assert.equal(typeof tenantContextWarn, "function");
});
test("2 guard mode is warn; no enforce", () => {
  const src = read(path.join("middlewares", "tenantContext.mw.js"));
  assert.match(src, /tenantContextMiddleware\(\{\s*mode:\s*"warn"\s*\}\)/);
  assert.ok(!/mode:\s*"enforce"/.test(src));
});
test("3 app.js requires tenantContextWarn", () => {
  assert.match(appSrc(), /require\("\.\/middlewares\/tenantContext\.mw"\)/);
});
test("4 global ordering: authenticate -> tenantContextWarn -> /api routes", () => {
  assert.match(
    appSrc(),
    /app\.use\(authenticate\);\s*\n\s*app\.use\(tenantContextWarn\);\s*\n\s*app\.use\("\/api",\s*require\("\.\/routes\/index"\)\)/
  );
});
test("5 exactly one global tenantContextWarn mount", () => {
  assert.equal((appSrc().match(/app\.use\(tenantContextWarn\)/g) || []).length, 1);
});
test("6 route inventory: event=13, registration=14, eventTemplate=6, course=5, certificate=1", () => {
  assert.equal(routeCount("event.routes.js"), 13);
  assert.equal(routeCount("registration.routes.js"), 14);
  assert.equal(routeCount("eventTemplate.routes.js"), 6);
  assert.equal(routeCount("course.routes.js"), 5);
  assert.equal(routeCount("certificate.routes.js"), 1);
});
test("7 total authenticated coverage = 39 (single global mount)", () => {
  const total =
    routeCount("event.routes.js") +
    routeCount("registration.routes.js") +
    routeCount("eventTemplate.routes.js") +
    routeCount("course.routes.js") +
    routeCount("certificate.routes.js");
  assert.equal(total, 39);
});
test("8 all 39 sit behind requirePermission (one per route, per file)", () => {
  for (const f of [
    ["event.routes.js", 13],
    ["registration.routes.js", 14],
    ["eventTemplate.routes.js", 6],
    ["course.routes.js", 5],
    ["certificate.routes.js", 1],
  ]) {
    assert.equal(permCount(f[0]), f[1], `${f[0]} requirePermission count`);
  }
});
test("9 public checkin mounted before authenticate/guard", () => {
  const s = appSrc();
  assert.ok(s.indexOf('app.use("/api/public"') < s.indexOf("app.use(authenticate)"));
  assert.ok(!routeSrc("publicCheckin.routes.js").includes("tenantContextWarn"));
});
test("10 GET /api info mounted before authenticate/guard", () => {
  const s = appSrc();
  assert.ok(s.indexOf('app.get("/api", ') < s.indexOf("app.use(authenticate)"));
});
test("11 /health mounted before authenticate/guard", () => {
  const s = appSrc();
  assert.ok(s.indexOf('app.get("/health"') < s.indexOf("app.use(authenticate)"));
});
test("12 /api/system-logs mounted before authenticate/guard", () => {
  const s = appSrc();
  assert.ok(s.indexOf("createSystemLogsRouter") < s.indexOf("app.use(authenticate)"));
});
test("13 auth.js unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("middlewares", "auth.js")).includes("tenantContextWarn"));
});
test("14 policy.middleware.js unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("middlewares", "policy.middleware.js")).includes("tenantContextWarn"));
});
test("15 route files unchanged (no guard reference)", () => {
  for (const f of ["event.routes.js", "registration.routes.js", "eventTemplate.routes.js", "course.routes.js", "certificate.routes.js", "publicCheckin.routes.js", "index.js"]) {
    assert.ok(!routeSrc(f).includes("tenantContextWarn"), `${f} must not reference the guard`);
  }
});
test("16 controllers unchanged (no guard reference)", () => {
  for (const c of fs.readdirSync(path.join(__dirname, "..", "controllers"))) {
    if (c.endsWith(".js")) assert.ok(!read(path.join("controllers", c)).includes("tenantContextWarn"));
  }
});
test("17 models unchanged (no guard reference)", () => {
  for (const m of fs.readdirSync(path.join(__dirname, "..", "models"))) {
    if (m.endsWith(".js")) assert.ok(!read(path.join("models", m)).includes("tenantContextWarn"));
  }
});
test("18 RabbitMQ code unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("rabbitMQ", "index.js")).includes("tenantContextWarn"));
  for (const p of ["publishers/event.lifecycle.publisher.js", "publishers/registration.events.publisher.js", "listeners/payment.status.listener.js"]) {
    assert.ok(!read(path.join("rabbitMQ", p)).includes("tenantContextWarn"));
  }
});
test("19 jobs unchanged (no guard reference)", () => {
  for (const j of ["eventCompletionSweep.js", "onlineAttendanceSyncSweep.js"]) {
    assert.ok(!read(path.join("jobs", j)).includes("tenantContextWarn"));
  }
});
test("20 package.json unchanged (shared-dep SHAs pinned; no guard ref)", () => {
  const pkg = read("package.json");
  assert.match(pkg, /policy-middleware\.git#1d4a3b991c6bb3374e424e220f745b48d41e3ee7/);
  assert.match(pkg, /logging-lib\.git#5fd251bde4ad08ba71cf9844656b5bc126e13b43/);
  assert.match(pkg, /rabbitmq-middleware\.git#db70fb8ae7a6e62f2a96df1f68b41ec4944d5123/);
  assert.ok(!pkg.includes("tenantContextWarn"));
});
test("21 package-lock.json resolves the three pins", () => {
  const lock = read("package-lock.json");
  assert.match(lock, /policy-middleware\.git#1d4a3b991c6bb3374e424e220f745b48d41e3ee7/);
  assert.match(lock, /logging-lib\.git#5fd251bde4ad08ba71cf9844656b5bc126e13b43/);
  assert.match(lock, /rabbitmq-middleware\.git#db70fb8ae7a6e62f2a96df1f68b41ec4944d5123/);
});

// ---- runtime behaviour (WARN, non-blocking) ----
test("22 trusted tenant cannot be replaced by query tenant", () => {
  const { req, nextCount } = run(gatewayReq({ query: { tenantId: OTHER } }));
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
});
test("23 trusted tenant cannot be replaced by body tenant", () => {
  const { req, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } }));
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
});
test("24 mismatch emits TenantContextMismatch (mode=warn, outcome=ignored)", () => {
  const { rows } = run(gatewayReq({ query: { tenantId: OTHER } }));
  const row = rows.find((r) => r.eventType === "TenantContextMismatch");
  assert.ok(row);
  assert.equal(row.mode, "warn");
  assert.equal(row.outcome, "ignored");
  assert.equal(row.trustedTenantId, TRUSTED);
  assert.ok(row.suppliedSources.includes("query"));
});
test("25 matching tenant emits no mismatch", () => {
  const { rows } = run(gatewayReq({ body: { tenantId: TRUSTED } }));
  assert.equal(rows.find((r) => r.eventType === "TenantContextMismatch"), undefined);
});
test("26 mismatch is non-blocking: next() called, no 403", () => {
  const { res, nextCount } = run(gatewayReq({ query: { tenantId: OTHER } }));
  assert.equal(nextCount, 1);
  assert.equal(res.statusCode, null);
  assert.ok(!res._s.includes(403));
});
test("27 WARN only, not enforce; package exposes both primitives", () => {
  const src = read(path.join("middlewares", "tenantContext.mw.js"));
  assert.match(src, /mode:\s*"warn"/);
  assert.ok(!/mode:\s*"enforce"/.test(src));
  assert.equal(typeof tenantContextMiddleware, "function");
  assert.equal(typeof resolveTenantContext, "function");
});
