/**
 * P5 S3 - signed registration-backed intent create (account operation intent_registration).
 *
 * In ACCOUNT_PAYMENT_COMMAND_MODE=bound, createRegistrationPaymentIntent WITH a registrationId (CRM
 * add-attendee card branch, CRM retry-payment) is sent as a signed internal S2S call; account-service
 * only evaluates intent_registration on the internal path without a user token
 * (serviceAuth.middleware.js createIntentRegistrationServiceAuth). Without a registrationId (PORTAL
 * branch) and in legacy mode the request is exactly the user-path request it was before.
 *
 * The verifier below is an INDEPENDENT re-implementation of account-service's check order for this
 * operation, written from contracts/p5-service-signing.v1.json (pinned by SHA-256, byte-identical in
 * account/events/profile) - it does not reuse this service's signer helpers, so a signer bug cannot
 * verify itself. It is first proven against every shared vector.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const SIGNING_VECTORS_SHA256 = "470d151d232a1acc00ae724afe05bc0986a0f5131fbc55861c3edd168383bf64";
const RAW = fs.readFileSync(path.join(__dirname, "..", "contracts", "p5-service-signing.v1.json"));
const V = JSON.parse(RAW.toString("utf8"));

// The user-path (legacy) URL is read once at module load (unchanged behaviour); the bound path reads
// ACCOUNT_SERVICE_URL per call and requires an in-network host.
const LEGACY_BASE = process.env.ACCOUNT_SERVICE_URL || "http://projectshell-vm.northeurope.cloudapp.azure.com/account-service";
const S = require("../services/accountCommandSigning");
const client = require("../services/accountService.client.js");

const BASE = "http://account-service:4000";
const T = "aaaaaaaaaaaaaaaaaaaaaaaa";
const REG = "b".repeat(24);
const SECRET = "TEST-ONLY-events-signer-secret-0123456789abcdef";
const OTHER_SECRET = "TEST-ONLY-profile-signer-secret-0123456789abcdef";
const KEYS = ["ACCOUNT_PAYMENT_COMMAND_MODE", "ACCOUNT_SERVICE_URL", "ACCOUNT_SIGNING_KID", "ACCOUNT_SIGNING_SECRET"];
const SVC_HEADERS = ["x-svc-caller", "x-svc-kid", "x-svc-nonce", "x-svc-sig", "x-svc-ts", "x-svc-version"];

// --- independent contract verifier (account-service evaluateServiceAuth order, intent_registration) ---
const ALLOW_INTENT_REGISTRATION = { registration: "events-service" };
const REGISTRATION_PURPOSES = new Set(["eventRegistration", "courseRegistration"]);
function lp(name, value) {
  const v = value == null ? "" : String(value);
  return `${name}=${Buffer.byteLength(v, "utf8")}:${v}`;
}
function contractCanonical(f, bodySha256) {
  return [
    `${V.contract}/${V.version}`,
    lp("aud", V.audience),
    lp("caller", f.caller),
    lp("kid", f.kid),
    lp("method", String(f.method).toUpperCase()),
    lp("target", f.target),
    lp("tenant", f.tenant),
    lp("idem", f.idem),
    lp("body", bodySha256),
    lp("ts", f.ts),
    lp("nonce", f.nonce),
  ].join("\n");
}
const hmac = (secret, s) => crypto.createHmac("sha256", secret).update(s, "utf8").digest("base64url");
const sha = (s) => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** Mirrors account: shape -> caller key map -> kid -> skew -> HMAC -> op x domain. (Nonce store not modelled.) */
function accountVerify({ url, headers, raw, keyMaps, nowSeconds }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (!h["x-svc-sig"] && !h["x-svc-caller"] && !h["x-svc-nonce"]) return "SERVICE_AUTH_REQUIRED";
  if (h["x-svc-version"] !== "1" || !h["x-svc-caller"] || !h["x-svc-kid"] || !/^\d+$/.test(h["x-svc-ts"] || "") || !h["x-svc-nonce"] || !h["x-svc-sig"]) {
    return "SERVICE_AUTH_MALFORMED";
  }
  const keys = keyMaps[h["x-svc-caller"]];
  if (!keys) return "SERVICE_AUTH_UNKNOWN_CALLER";
  const secret = keys[h["x-svc-kid"]];
  if (!secret) return "SERVICE_AUTH_UNKNOWN_KID";
  if (Math.abs(nowSeconds - Number(h["x-svc-ts"])) > V.maxSkewSeconds) return "SERVICE_AUTH_STALE";
  const u = new URL(url);
  const canonical = contractCanonical(
    { caller: h["x-svc-caller"], kid: h["x-svc-kid"], method: "POST", target: `${u.pathname}${u.search}`, tenant: h["x-tenant-id"] || "", idem: h["idempotency-key"] || "", ts: h["x-svc-ts"], nonce: h["x-svc-nonce"] },
    sha(raw),
  );
  const expected = Buffer.from(hmac(secret, canonical));
  const got = Buffer.from(String(h["x-svc-sig"]));
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return "SERVICE_AUTH_INVALID";
  const body = JSON.parse(raw);
  const domain = REGISTRATION_PURPOSES.has(String(body.purpose)) && body.registrationId ? "registration" : null;
  if (ALLOW_INTENT_REGISTRATION[domain] !== h["x-svc-caller"]) return "SERVICE_NOT_ALLOWED";
  return "valid";
}
/** account mounts the intent_registration verifier only for this shape (createIntentRegistrationServiceAuth). */
function accountEvaluatesIntentRegistration(headers, body) {
  const userToken = Boolean(headers.authorization || headers["x-jwt-verified"]);
  return !userToken && headers["x-internal-request"] === "true" && REGISTRATION_PURPOSES.has(String(body.purpose)) && Boolean(body.registrationId);
}
const KEY_MAPS = { "events-service": { "ev-1": SECRET }, "profile-service": { "pr-1": OTHER_SECRET } };

const saved = {};
let post;
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  S.resetUnconfiguredWarning();
  process.env.ACCOUNT_PAYMENT_COMMAND_MODE = "bound";
  process.env.ACCOUNT_SERVICE_URL = BASE;
  process.env.ACCOUNT_SIGNING_KID = "ev-1";
  process.env.ACCOUNT_SIGNING_SECRET = SECRET;
  post = jest.spyOn(axios, "post").mockResolvedValue({
    data: { data: { id: "c".repeat(24), paymentIntentId: "pi_t_1", clientSecret: "pi_t_1_secret_sentinel", status: "requires_payment_method" } },
  });
});
afterEach(() => jest.restoreAllMocks());

const req = {
  headers: {
    authorization: "Bearer crm-user-sentinel",
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": "u".repeat(24),
    "x-user-type": "CRM",
    "x-user-roles": "[]",
    "x-user-permissions": "[\"events:write\"]",
    "x-tenant-id": T,
    "x-correlation-id": "corr-1",
  },
};
// CRM add-attendee card branch (registrationId, profile unresolved, product codes present)
const crmCreate = () =>
  client.createRegistrationPaymentIntent({ req, tenantId: T, registrationId: REG, profileId: undefined, membershipNumber: "M-1", amount: 1250, currency: "eur", productCode: "EV-1", eventCategoryCode: "CPD", purpose: "eventRegistration" });
// CRM retry-payment (registrationId, no product codes, course)
const retryCreate = () =>
  client.createRegistrationPaymentIntent({ req, tenantId: T, registrationId: REG, profileId: undefined, membershipNumber: undefined, amount: 900, currency: "eur", productCode: null, eventCategoryCode: null, purpose: "courseRegistration" });
// PORTAL branch (no registrationId; event target instead)
const portalCreate = () =>
  client.createRegistrationPaymentIntent({ req, tenantId: T, profileId: "p".repeat(24), amount: 1250, currency: "eur", purpose: "eventRegistration", entityType: "event", entityId: "e".repeat(24) });

const rawOf = (call) => (call[2].transformRequest ? call[2].transformRequest[0](call[1], call[2].headers) : JSON.stringify(call[1]));
const nowS = () => Math.floor(Date.now() / 1000);

test("independent verifier reproduces every shared vector (file pinned)", () => {
  expect(crypto.createHash("sha256").update(RAW).digest("hex")).toBe(SIGNING_VECTORS_SHA256);
  for (const v of V.vectors) {
    const { body, ...f } = v.input;
    expect(sha(body)).toBe(v.expect.bodySha256);
    const c = contractCanonical(f, sha(body));
    expect(c).toBe(v.expect.canonical);
    expect(hmac(v.secret, c)).toBe(v.expect.sig);
  }
});

for (const [name, run, purpose] of [["CRM add-attendee card create", crmCreate, "eventRegistration"], ["CRM retry-payment create", retryCreate, "courseRegistration"]]) {
  test(`bound + keys: ${name} is a signed internal call that account's intent_registration verifier accepts`, async () => {
    const out = await run();
    expect(out).toMatchObject({ paymentIntentId: "pi_t_1", clientSecret: "pi_t_1_secret_sentinel" }); // response passed through
    expect(post).toHaveBeenCalledTimes(1);
    const call = post.mock.calls[0];
    const [url, body, cfg] = call;
    expect(url).toBe(`${BASE}/api/payments/intents`);
    const h = cfg.headers;
    // internal-only identity: never the user token or x-user-* (account: 401 UNVERIFIED_IDENTITY, and a
    // token would make account skip the verifier altogether)
    for (const k of Object.keys(h)) expect(k.toLowerCase()).not.toMatch(/^(authorization|x-user-|x-jwt-verified|x-auth-source)/);
    expect(h["x-internal-request"]).toBe("true");
    expect(h["x-tenant-id"]).toBe(T);
    expect(h["x-correlation-id"]).toBe("corr-1");
    expect(Object.keys(h).some((k) => k.toLowerCase() === "idempotency-key")).toBe(false);
    expect(Object.keys(h).filter((k) => k.startsWith("x-svc-")).sort()).toEqual(SVC_HEADERS);
    expect(h["x-svc-caller"]).toBe("events-service");
    expect(h["x-svc-kid"]).toBe("ev-1");
    const raw = rawOf(call);
    expect(JSON.parse(raw)).toEqual(body);
    expect(body).toMatchObject({ registrationId: REG, purpose, ledgerDomain: "events", source: "events-service" });
    expect(accountEvaluatesIntentRegistration(h, body)).toBe(true);
    expect(accountVerify({ url, headers: h, raw, keyMaps: KEY_MAPS, nowSeconds: nowS() })).toBe("valid");
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });
}

test("bound + keys: the signed body is exactly the body the legacy user-path request sends", async () => {
  await crmCreate();
  await retryCreate();
  process.env.ACCOUNT_PAYMENT_COMMAND_MODE = "legacy";
  await crmCreate();
  await retryCreate();
  const [b1, b2, l1, l2] = post.mock.calls.map((c) => c[1]);
  expect(b1).toEqual(l1);
  expect(b2).toEqual(l2);
  // optional nulls / undefined are omitted, never sent as null (account zCreateIntent rejects null)
  expect(Object.prototype.hasOwnProperty.call(JSON.parse(rawOf(post.mock.calls[1])), "productCode")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(JSON.parse(rawOf(post.mock.calls[1])), "profileId")).toBe(false);
});

test("account-side negatives on a sent create: tampered body / target / tenant, wrong key, stale, wrong caller", async () => {
  await crmCreate();
  const [url, body, cfg] = post.mock.calls[0];
  const raw = rawOf(post.mock.calls[0]);
  const h = cfg.headers;
  const ok = (o) => accountVerify({ url, headers: h, raw, keyMaps: KEY_MAPS, nowSeconds: nowS(), ...o });
  expect(ok({})).toBe("valid");
  expect(ok({ raw: raw.replace('"amount":1250', '"amount":1') })).toBe("SERVICE_AUTH_INVALID");
  expect(ok({ url: `${url}?x=1` })).toBe("SERVICE_AUTH_INVALID");
  expect(ok({ headers: { ...h, "x-tenant-id": "f".repeat(24) } })).toBe("SERVICE_AUTH_INVALID");
  expect(ok({ headers: { ...h, "Idempotency-Key": "registration:intent:x" } })).toBe("SERVICE_AUTH_INVALID");
  expect(ok({ keyMaps: { "events-service": { "ev-1": OTHER_SECRET } } })).toBe("SERVICE_AUTH_INVALID");
  expect(ok({ keyMaps: { "events-service": { "ev-0": SECRET } } })).toBe("SERVICE_AUTH_UNKNOWN_KID");
  expect(ok({ nowSeconds: nowS() + V.maxSkewSeconds + 5 })).toBe("SERVICE_AUTH_STALE");
  expect(ok({ headers: { ...h, "x-svc-sig": undefined, "x-svc-caller": undefined, "x-svc-nonce": undefined } })).toBe("SERVICE_AUTH_REQUIRED");
  // a validly signed profile-service request for the same operation is refused after the HMAC check
  const target = new URL(url).pathname;
  const ts = String(nowS());
  const c = contractCanonical({ caller: "profile-service", kid: "pr-1", method: "POST", target, tenant: T, idem: "", ts, nonce: "bm9uY2UtcHJvZmlsZS0wMDAx" }, sha(raw));
  const ph = { ...h, "x-svc-caller": "profile-service", "x-svc-kid": "pr-1", "x-svc-ts": ts, "x-svc-nonce": "bm9uY2UtcHJvZmlsZS0wMDAx", "x-svc-sig": hmac(OTHER_SECRET, c) };
  expect(ok({ headers: ph })).toBe("SERVICE_NOT_ALLOWED");
  expect(JSON.parse(raw)).toEqual(body);
});

test("retry of the same create: fresh nonce each time, identical bytes", async () => {
  await crmCreate();
  await crmCreate();
  const [a, b] = post.mock.calls.map((c) => c[2].headers);
  expect(a["x-svc-nonce"]).not.toBe(b["x-svc-nonce"]);
  expect(rawOf(post.mock.calls[0])).toBe(rawOf(post.mock.calls[1]));
});

test("bound + keys, PORTAL branch (no registrationId): unchanged user-path request, never signed", async () => {
  await portalCreate();
  const [url, body, cfg] = post.mock.calls[0];
  expect(url).toBe(`${LEGACY_BASE}/api/payments/intents`);
  expect(cfg.transformRequest).toBeUndefined();
  expect(Object.keys(cfg.headers).filter((k) => k.startsWith("x-svc-"))).toEqual([]);
  expect(cfg.headers.authorization).toBe("Bearer crm-user-sentinel");
  expect(cfg.headers["x-user-id"]).toBe("u".repeat(24));
  expect(body.registrationId).toBeUndefined();
  expect(body).toMatchObject({ entityType: "event", entityId: "e".repeat(24) });
  expect(accountEvaluatesIntentRegistration(cfg.headers, body)).toBe(false);
});

test("bound, keys absent: internal call sent unsigned with the one-per-process [svc-sign] warning", async () => {
  delete process.env.ACCOUNT_SIGNING_KID;
  delete process.env.ACCOUNT_SIGNING_SECRET;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  await crmCreate();
  await retryCreate();
  expect(post).toHaveBeenCalledTimes(2);
  for (const call of post.mock.calls) {
    const h = call[2].headers;
    expect(Object.keys(h).filter((k) => k.startsWith("x-svc-"))).toEqual([]);
    expect(h.authorization).toBeUndefined();
    expect(h["x-internal-request"]).toBe("true");
    // account report mode logs result=unsigned; enforce refuses an unsigned internal create (401)
    expect(accountVerify({ url: call[0], headers: h, raw: rawOf(call), keyMaps: KEY_MAPS, nowSeconds: nowS() })).toBe("SERVICE_AUTH_REQUIRED");
  }
  const lines = warn.mock.calls.map((a) => a.join(" ")).filter((l) => l.startsWith("[svc-sign]"));
  expect(lines).toEqual(["[svc-sign] account command signing not configured; sending unsigned caller=events-service"]);
});

test("bound, misconfigured signing: fails closed (503) before any request", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  process.env.ACCOUNT_SIGNING_SECRET = "short";
  await expect(crmCreate()).rejects.toMatchObject({ code: "ACCOUNT_SIGNING_MISCONFIGURED" });
  expect(post).not.toHaveBeenCalled();
});

test("bound with a gateway ACCOUNT_SERVICE_URL: refused (internal URL required) before any request", async () => {
  process.env.ACCOUNT_SERVICE_URL = "https://gateway.example.invalid/account-service";
  await expect(crmCreate()).rejects.toMatchObject({ code: "ACCOUNT_INTERNAL_URL_REQUIRED" });
  expect(post).not.toHaveBeenCalled();
});

test("legacy mode (keys present): exactly the previous user-path request for every branch", async () => {
  process.env.ACCOUNT_PAYMENT_COMMAND_MODE = "legacy";
  for (const run of [crmCreate, retryCreate, portalCreate]) await run();
  expect(post).toHaveBeenCalledTimes(3);
  for (const [url, , cfg] of post.mock.calls) {
    expect(url).toBe(`${LEGACY_BASE}/api/payments/intents`);
    expect(cfg).toEqual({
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": T,
        "x-internal-request": "true",
        authorization: "Bearer crm-user-sentinel",
        "x-jwt-verified": "true",
        "x-auth-source": "gateway",
        "x-user-id": "u".repeat(24),
        "x-user-type": "CRM",
        "x-user-roles": "[]",
        "x-user-permissions": "[\"events:write\"]",
        "x-correlation-id": "corr-1",
      },
      timeout: 15000,
    });
  }
  expect(post.mock.calls[0][1]).toEqual({
    tenantId: T,
    registrationId: REG,
    memberId: "M-1",
    productCode: "EV-1",
    eventCategoryCode: "CPD",
    amount: 1250,
    currency: "eur",
    purpose: "eventRegistration",
    ledgerDomain: "events",
    source: "events-service",
    profileId: undefined,
  });
});
