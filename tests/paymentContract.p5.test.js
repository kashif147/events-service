/**
 * P5 cross-service payment command contract - events-service (caller side).
 *
 * contracts/p5-bound-payment-commands.v1.json is committed byte-identically in account-service,
 * events-service and profile-service (SHA-256 pinned below and in the other two repos). Here every
 * events-service case is produced through the REAL account client (bound mode) and the request
 * actually handed to axios must equal the fixture's `request` exactly: path, headers (only the
 * contract's allowed headers; never identity), and body. account-service replays the same
 * requests against its real router (src/tests/paymentContract.p5.test.mjs), so a serialisation
 * drift on either side fails a suite.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CONTRACT_SHA256 = "f0d9d619e1f17c3868d4dc6b73772bdeeebbe0b6e48cd11e245ad9116253a065";
const RAW = fs.readFileSync(path.join(__dirname, "../contracts/p5-bound-payment-commands.v1.json"));
const C = JSON.parse(RAW.toString("utf8"));

const client = require("../services/accountService.client.js");

const BASE = "http://account-service:4000";
let post;
const savedEnv = {};
beforeAll(() => {
  for (const k of ["ACCOUNT_PAYMENT_COMMAND_MODE", "ACCOUNT_SERVICE_URL"]) savedEnv[k] = process.env[k];
  process.env.ACCOUNT_PAYMENT_COMMAND_MODE = "bound";
  process.env.ACCOUNT_SERVICE_URL = BASE;
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  post = jest.spyOn(axios, "post").mockResolvedValue({ data: { data: { status: "succeeded", paymentId: "c0000000000000000000000f" } } });
});
afterEach(() => jest.restoreAllMocks());

// The inbound CRM request carries a full user identity: none of it may reach account.
const inboundReq = {
  headers: {
    authorization: "Bearer contract-sentinel",
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": C.ids.actorUserId,
    "x-user-type": "CRM",
    "x-user-roles": "MO",
    "x-user-permissions": "events:write",
  },
};

function commandFor(c, reason) {
  return {
    registrationId: c.inputs.registrationId,
    registrationType: c.inputs.registrationType,
    actorUserId: C.ids.actorUserId,
    reason,
    paymentId: c.inputs.paymentId || null,
  };
}

const CALLS = {
  capture: (c, reason) => client.capturePaymentIntent({
    req: inboundReq, tenantId: C.ids.tenantId, paymentIntentId: c.inputs.paymentIntentId,
    profileId: C.ids.profileId, membershipNumber: C.ids.memberId, command: commandFor(c, reason),
  }),
  cancel: (c, reason) => client.cancelPaymentIntent({
    req: inboundReq, tenantId: C.ids.tenantId, paymentIntentId: c.inputs.paymentIntentId, command: commandFor(c, reason),
  }),
  manual_record: (c, reason) => client.postManualRegistrationPayment({
    req: inboundReq, tenantId: C.ids.tenantId, registrationId: c.inputs.registrationId,
    profileId: C.ids.profileId, membershipNumber: C.ids.memberId, eventCategoryCode: c.inputs.eventCategoryCode,
    amount: c.inputs.amount, currency: c.inputs.currency, method: c.inputs.method, command: commandFor(c, reason),
  }),
  manual_post: (c, reason) => client.postManualRegistrationPaymentToGL({
    req: inboundReq, tenantId: C.ids.tenantId, paymentId: c.inputs.paymentId, method: c.inputs.method,
    profileId: C.ids.profileId, membershipNumber: C.ids.memberId, command: commandFor(c, reason),
  }),
  manual_void: (c, reason) => client.voidManualRegistrationPayment({
    req: inboundReq, tenantId: C.ids.tenantId, paymentId: c.inputs.paymentId, command: commandFor(c, reason),
  }),
};

test("contract fixture is the pinned version (byte-identical across the three repos)", () => {
  expect(crypto.createHash("sha256").update(RAW).digest("hex")).toBe(CONTRACT_SHA256);
  expect(C.contract).toBe("p5-bound-payment-commands");
  expect(C.version).toBe(1);
});

const mine = C.cases.filter((c) => c.caller === "events-service");
test("every events-service transition and reason in the contract is covered", () => {
  expect(mine.map((c) => c.name).sort()).toEqual([
    "registration.cancel.event_cancelled",
    "registration.cancel.reject",
    "registration.capture.approve",
    "registration.manual_post.approve",
    "registration.manual_record.crm_add_attendee",
    "registration.manual_void.event_cancelled",
    "registration.manual_void.payment_method_switched",
    "registration.manual_void.reject",
  ]);
});

test.each(mine.map((c) => [c.name, c]))("%s: the serialized request equals the contract", async (_name, c) => {
  const [, transition, reason] = c.name.split(".");
  await CALLS[transition](c, reason);
  expect(post).toHaveBeenCalledTimes(1);
  const [url, body, cfg] = post.mock.calls[0];
  expect(url).toBe(`${BASE}${c.request.path}`);
  const sent = { ...cfg.headers };
  expect(sent["Content-Type"]).toBe("application/json");
  delete sent["Content-Type"];
  delete sent["x-correlation-id"];
  expect(sent).toEqual(c.request.headers);
  for (const h of Object.keys(cfg.headers)) expect(C.rules.allowedHeaders).toContain(h.toLowerCase());
  expect(JSON.stringify(cfg.headers)).not.toContain("contract-sentinel");
  expect(body).toEqual(c.request.body);
});
