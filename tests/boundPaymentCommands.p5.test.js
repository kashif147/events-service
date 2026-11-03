/**
 * P5 bound payment commands, caller side (S2) - events-service.
 *
 * With ACCOUNT_PAYMENT_COMMAND_MODE=bound every capture / cancel / manual record / manual post /
 * manual void is sent to account-service as an internal-only bound command:
 *  - headers: x-internal-request + x-tenant-id (+ correlation id, deterministic Idempotency-Key),
 *    NEVER authorization / x-jwt-verified / x-auth-source / x-user-*, even when the inbound CRM
 *    request carried them;
 *  - body: { binding:{domain:"registration", registrationId, purpose, paymentId?}, transition,
 *    reason, actorUserId, link? / record? } (b5 payment-mutation contract 3.2);
 *  - sent only AFTER the registration holds a committed, decision-specific claim
 *    (approve / reject) or already-committed state (event cancelled, method switched);
 *  - 409 / 503 from account leaves the registration exactly as it was before the action.
 * Legacy mode (default) keeps today's requests byte-for-byte.
 */
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const axios = require("axios");

jest.mock("../services/profileLookup.client.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");
jest.mock("../rabbitMQ/publishers/event.lifecycle.publisher.js");
const { getProfileMembershipNumber, updateAttendeeProfileFields } = require("../services/profileLookup.client.js");

const client = require("../services/accountService.client.js");
const app = require("../app");
const Event = require("../models/event.model.js");
const Registration = require("../models/registration.model.js");

const TENANT = "a1b2c3d4e5f6a7b8c9d0e1f2";
const CRM_USER = "c0ffee00c0ffee00c0ffee01";
const IDENTITY_KEYS = ["authorization", "x-jwt-verified", "x-auth-source", "x-user-id", "x-user-email", "x-user-type", "x-user-roles", "x-user-permissions"];

function authHeader() {
  const token = jwt.sign({ sub: CRM_USER, id: CRM_USER, tenantId: TENANT, userType: "CRM", roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

let counter = 0;
async function registration(overrides = {}) {
  counter += 1;
  const email = `bound${counter}@example.com`;
  return Registration.create({
    tenantId: TENANT,
    registrationType: "event",
    eventId: new mongoose.Types.ObjectId(),
    approvalStatus: "pending_review",
    duplicateReview: { status: "EXACT_MATCH", matchedProfileId: "profile-1" },
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 5000,
    currency: "eur",
    paymentMethod: "stripe",
    paymentStatus: "authorized",
    status: "pending",
    stripePaymentIntentId: `pi_bound_${counter}`,
    paymentId: new mongoose.Types.ObjectId(),
    registeredVia: "crm",
    isActive: true,
    ...overrides,
  });
}

function axiosError(status, code = "TRANSITION_NOT_ALLOWED") {
  const err = new Error(`Request failed with status code ${status}`);
  err.isAxiosError = true;
  err.response = { status, data: { status: "fail", message: "refused", code } };
  return err;
}
function networkError() {
  const err = new Error("connect ECONNREFUSED");
  err.isAxiosError = true;
  err.code = "ECONNREFUSED";
  return err;
}

let post;
const savedEnv = {};
beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});
beforeEach(() => {
  for (const k of ["ACCOUNT_PAYMENT_COMMAND_MODE", "ACCOUNT_SERVICE_URL"]) savedEnv[k] = process.env[k];
  process.env.ACCOUNT_PAYMENT_COMMAND_MODE = "bound";
  process.env.ACCOUNT_SERVICE_URL = "http://account-service:4000";
  post = jest.spyOn(axios, "post");
  getProfileMembershipNumber.mockResolvedValue(null);
  updateAttendeeProfileFields.mockResolvedValue({});
});
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  post.mockRestore();
  jest.clearAllMocks();
  await Registration.deleteMany({ tenantId: TENANT });
  await Event.deleteMany({ tenantId: TENANT });
});
afterAll(async () => {
  await mongoose.disconnect();
});

function expectInternalOnly(headers) {
  for (const k of IDENTITY_KEYS) expect(headers).not.toHaveProperty(k);
  expect(headers["x-internal-request"]).toBe("true");
  expect(headers["x-tenant-id"]).toBe(TENANT);
}

const inboundReq = {
  headers: {
    authorization: "Bearer sentinel-not-forwarded",
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": CRM_USER,
    "x-user-type": "CRM",
    "x-user-roles": "MO",
    "x-user-permissions": "events:write",
    "x-correlation-id": "corr-1",
  },
};

describe("client: bound command envelope and headers", () => {
  const command = { registrationId: "r1", registrationType: "event", actorUserId: CRM_USER, reason: "approve", paymentId: "p1" };

  test("capture: internal-only headers, binding, link, deterministic key", async () => {
    post.mockResolvedValue({ data: { data: { captured: true } } });
    const out = await client.capturePaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", profileId: "prof-1", membershipNumber: "M1", command });
    expect(out.status).toBe("succeeded");
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe("http://account-service:4000/api/payments/intents/pi_1/capture");
    expectInternalOnly(cfg.headers);
    expect(cfg.headers["x-correlation-id"]).toBe("corr-1");
    expect(cfg.headers["Idempotency-Key"]).toBe("registration:capture:r1:pi_1"); // canonical contract key
    expect(body).toEqual({
      binding: { domain: "registration", registrationId: "r1", purpose: "eventRegistration", paymentId: "p1" },
      transition: "capture",
      reason: "approve",
      actorUserId: CRM_USER,
      link: { profileId: "prof-1", memberId: "M1" },
    });
    expect(JSON.stringify(cfg.headers)).not.toContain("sentinel-not-forwarded");
  });

  test.each([
    ["cancel", () => client.cancelPaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", command: { ...command, reason: "reject" } }), "/api/payments/intents/pi_1/cancel", { transition: "cancel", reason: "reject" }],
    ["manual_post", () => client.postManualRegistrationPaymentToGL({ req: inboundReq, tenantId: TENANT, paymentId: "p1", method: "invoice", profileId: "prof-1", command }), "/api/journal/events/manual-payment/post", { transition: "manual_post", reason: "approve", link: { profileId: "prof-1" } }],
    ["manual_void", () => client.voidManualRegistrationPayment({ req: inboundReq, tenantId: TENANT, paymentId: "p1", command: { ...command, reason: "event_cancelled" } }), "/api/journal/events/manual-payment/void", { transition: "manual_void", reason: "event_cancelled" }],
  ])("%s envelope", async (_n, call, path, expected) => {
    post.mockResolvedValue({ data: { data: {} } });
    await call();
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe(`http://account-service:4000${path}`);
    expectInternalOnly(cfg.headers);
    expect(body.binding).toEqual({ domain: "registration", registrationId: "r1", purpose: "eventRegistration", paymentId: "p1" });
    expect(body).toMatchObject({ actorUserId: CRM_USER, ...expected });
    expect(body).not.toHaveProperty("tenantId");
    expect(body).not.toHaveProperty("profileId");
  });

  test("manual_record: server-priced record, no paymentId yet, course purpose", async () => {
    post.mockResolvedValue({ data: { data: { id: "pay-new" } } });
    const out = await client.postManualRegistrationPayment({
      req: inboundReq, tenantId: TENANT, registrationId: "r9", amount: 1200, currency: "eur", method: "comp", productCode: "EVT1",
      command: { registrationId: "r9", registrationType: "course", actorUserId: CRM_USER, reason: "crm_add_attendee" },
    });
    expect(out.paymentId).toBe("pay-new");
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe("http://account-service:4000/api/journal/events/manual-payment");
    expectInternalOnly(cfg.headers);
    expect(cfg.headers["Idempotency-Key"]).toBe("registration:manual_record:r9:new"); // canonical contract key
    expect(body).toEqual({
      binding: { domain: "registration", registrationId: "r9", purpose: "courseRegistration" },
      transition: "manual_record",
      reason: "crm_add_attendee",
      actorUserId: CRM_USER,
      record: { amount: 1200, currency: "eur", method: "comp", productCode: "EVT1" },
    });
  });

  test.each([
    ["gateway URL", () => { process.env.ACCOUNT_SERVICE_URL = "https://gw.example.com/account-service"; }, 503, "ACCOUNT_INTERNAL_URL_REQUIRED"],
    ["no URL", () => { delete process.env.ACCOUNT_SERVICE_URL; }, 503, "ACCOUNT_INTERNAL_URL_REQUIRED"],
  ])("refuses before calling: %s", async (_n, setup, status, code) => {
    setup();
    await expect(client.cancelPaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", command })).rejects.toMatchObject({ status, code });
    expect(post).not.toHaveBeenCalled();
  });

  test.each([
    ["non-ObjectId tenant", { tenantId: "tenant-x" }, "TENANT_REQUIRED"],
    ["missing actor", { command: { ...command, actorUserId: null } }, "ACTOR_REQUIRED"],
    ["missing registration", { command: { ...command, registrationId: null } }, "PAYMENT_BINDING_REQUIRED"],
    ["missing reason", { command: { ...command, reason: undefined } }, "REASON_REQUIRED"],
  ])("refuses before calling: %s", async (_n, over, code) => {
    await expect(client.cancelPaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", command, ...over })).rejects.toMatchObject({ status: 400, code });
    expect(post).not.toHaveBeenCalled();
  });

  test("network failure -> 503 ACCOUNT_UNAVAILABLE; account 409 passes through unchanged", async () => {
    post.mockRejectedValueOnce(networkError());
    await expect(client.cancelPaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", command })).rejects.toMatchObject({ status: 503, code: "ACCOUNT_UNAVAILABLE" });
    const conflict = axiosError(409);
    post.mockRejectedValueOnce(conflict);
    await expect(client.cancelPaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", command })).rejects.toBe(conflict);
  });

  test("legacy mode (default) is unchanged: forwards identity, no envelope", async () => {
    delete process.env.ACCOUNT_PAYMENT_COMMAND_MODE;
    post.mockResolvedValue({ data: { data: { status: "canceled" } } });
    await client.cancelPaymentIntent({ req: inboundReq, tenantId: TENANT, paymentIntentId: "pi_1", command });
    const [, body, cfg] = post.mock.calls[0];
    expect(body).toEqual({});
    expect(cfg.headers.authorization).toBe("Bearer sentinel-not-forwarded");
  });
});

describe("approve: committed approve claim before the capture", () => {
  test("capture sent once, after the claim is committed; never with identity", async () => {
    const reg = await registration();
    let seen = null;
    post.mockImplementation(async () => {
      seen = await Registration.findById(reg._id).lean();
      return { data: { data: { captured: true } } };
    });
    const res = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(1);
    expect(seen.approvalStatus).toBe("processing");
    expect(seen.paymentDecision.action).toBe("approve");
    expect(seen.paymentDecision.actorUserId).toBe(CRM_USER);
    const [, body, cfg] = post.mock.calls[0];
    expectInternalOnly(cfg.headers);
    {
      expect(body).toMatchObject({
        transition: "capture",
        reason: "approve",
        actorUserId: CRM_USER,
        binding: { domain: "registration", registrationId: String(reg._id), paymentId: String(reg.paymentId) },
        link: { profileId: "profile-1" },
      });
    }
    const after = await Registration.findById(reg._id).lean();
    expect(after).toMatchObject({ approvalStatus: "approved", status: "confirmed", paymentStatus: "succeeded" });
  });

  test("manual (invoice) approve -> manual_post bound to the stored paymentId", async () => {
    const reg = await registration({ paymentMethod: "invoice", paymentStatus: "manual", stripePaymentIntentId: null });
    post.mockResolvedValue({ data: { data: { posted: true } } });
    const res = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    const [url, body] = post.mock.calls[0];
    expect(url).toMatch(/\/manual-payment\/post$/);
    expect(body.binding.paymentId).toBe(String(reg.paymentId));
    expect(body.transition).toBe("manual_post");
  });

  test.each([
    ["account 409", () => axiosError(409), 409],
    ["account unreachable", () => networkError(), 503],
  ])("%s -> no partial state: claim released, still pending, no decision left", async (_n, err, status) => {
    const reg = await registration();
    post.mockRejectedValue(err());
    const res = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(res.status).toBe(status);
    const after = await Registration.findById(reg._id).lean();
    expect(after.approvalStatus).toBe("pending_review");
    expect(after.status).toBe("pending");
    expect(after.paymentDecision).toBeUndefined();
  });

  test("reject while the approve claim is held -> refused, no cancel sent", async () => {
    const reg = await registration();
    let rejectRes;
    post.mockImplementation(async () => {
      rejectRes = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", authHeader());
      return { data: { data: { captured: true } } };
    });
    const res = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(rejectRes.status).toBe(400);
    expect(post).toHaveBeenCalledTimes(1); // the capture only
  });

  test("two concurrent approves -> exactly one capture", async () => {
    const reg = await registration();
    post.mockResolvedValue({ data: { data: { captured: true } } });
    const [a, b] = await Promise.all([
      request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader()),
      request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("reject: committed reject claim before the cancel/void", () => {
  test("cancel carries reason reject after the reject claim is committed", async () => {
    const reg = await registration();
    let seen = null;
    post.mockImplementation(async () => {
      seen = await Registration.findById(reg._id).lean();
      return { data: { data: { canceled: true } } };
    });
    const res = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(seen.paymentDecision.action).toBe("reject");
    const [, body, cfg] = post.mock.calls[0];
    expectInternalOnly(cfg.headers);
    expect(body).toMatchObject({ transition: "cancel", reason: "reject", binding: { registrationId: String(reg._id) } });
    const after = await Registration.findById(reg._id).lean();
    expect(after).toMatchObject({ approvalStatus: "rejected", status: "cancelled", isActive: false });
  });

  test("account 409 on void -> back to pending_review, decision cleared", async () => {
    const reg = await registration({ paymentMethod: "manual", paymentStatus: "manual", stripePaymentIntentId: null });
    post.mockRejectedValue(axiosError(409, "ALREADY_POSTED"));
    const res = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", authHeader());
    expect(res.status).toBe(409);
    const after = await Registration.findById(reg._id).lean();
    expect(after.approvalStatus).toBe("pending_review");
    expect(after.isActive).toBe(true);
    expect(after.paymentDecision).toBeUndefined();
  });
});

describe("retry-payment manual -> card: void only after the switch is committed", () => {
  test("void of the superseded manual Payment is sent after the registration points at the new intent", async () => {
    const oldPaymentId = new mongoose.Types.ObjectId();
    const reg = await registration({ paymentMethod: "manual", paymentStatus: "manual", stripePaymentIntentId: null, paymentId: oldPaymentId });
    let seen = null; // state committed when the void is sent (asserted after: the controller swallows void errors)
    post.mockImplementation(async (url) => {
      if (url.endsWith("/api/payments/intents")) {
        return { data: { data: { paymentIntentId: "pi_switched", id: String(new mongoose.Types.ObjectId()), status: "requires_payment_method", clientSecret: "cs_test_only" } } };
      }
      seen = await Registration.findById(reg._id).lean();
      return { data: { data: { voided: true } } };
    });
    const res = await request(app).post(`/api/registrations/${reg._id}/retry-payment`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(post.mock.calls.map((c) => c[0].split("/api/")[1])).toEqual(["payments/intents", "journal/events/manual-payment/void"]);
    expect(seen.paymentMethod).toBe("stripe");
    expect(seen.stripePaymentIntentId).toBe("pi_switched");
    expect(String(seen.paymentId)).not.toBe(String(oldPaymentId));
    const [, body, cfg] = post.mock.calls[1];
    expectInternalOnly(cfg.headers);
    expect(body).toMatchObject({
      transition: "manual_void",
      reason: "payment_method_switched",
      binding: { registrationId: String(reg._id), paymentId: String(oldPaymentId) },
    });
  });
});

describe("event cancel: release sent after the registration is committed cancelled", () => {
  test("pending stripe registration -> cancel with reason event_cancelled", async () => {
    const event = await Event.create({ tenantId: TENANT, title: "Bound", startDate: new Date("2030-01-01T09:00:00Z"), endDate: new Date("2030-01-01T17:00:00Z"), status: "Published", createdBy: CRM_USER });
    const reg = await registration({ eventId: event._id });
    let seen = null; // asserted after: cancelEvent swallows release errors
    post.mockImplementation(async () => {
      seen = await Registration.findById(reg._id).lean();
      return { data: { data: { canceled: true } } };
    });
    const res = await request(app).put(`/api/events/${event._id}/cancel`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ status: "cancelled", isActive: false });
    const [, body, cfg] = post.mock.calls[0];
    expectInternalOnly(cfg.headers);
    expect(body).toMatchObject({ transition: "cancel", reason: "event_cancelled", binding: { registrationId: String(reg._id) } });
  });
});
