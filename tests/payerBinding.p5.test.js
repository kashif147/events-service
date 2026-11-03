/**
 * P5 payer binding - events side of the event/course PaymentIntent binding.
 *
 * createRegistration (PORTAL, pre-authorized stripePaymentIntentId and the no-PI path) sends
 * the registration's binding to account-service's attach, treats a 409 (lost/duplicate
 * attach) as a clean failure with no orphan Registration, and refuses another payer's /
 * another event's intent. payment.status.listener only changes a registration when the
 * status is for that registration's OWN payment (paymentId / stripePaymentIntentId).
 * account-service is mocked; MongoDB is the test mongod (MONGO_URI).
 */
process.env.AUTH_BYPASS_ENABLED = "false";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => require("./helpers/pdpMock.js").createPdpMock());
jest.mock("../services/accountService.client.js");
jest.mock("../services/profileLookup.client.js");
jest.mock("../services/subscriptionLookup.client.js");
jest.mock("../services/lookup.client.js");
jest.mock("../services/pricing.client.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");

const {
  createRegistrationPaymentIntent,
  getPaymentByPaymentIntentId,
  attachRegistrationToPaymentIntent,
} = require("../services/accountService.client.js");
const { getCallerOwnProfile, checkAttendeeDuplicates } = require("../services/profileLookup.client.js");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");
const { resolveLookupNamesByIds } = require("../services/lookup.client.js");
const { getCurrentPriceForProduct } = require("../services/pricing.client.js");
const { publishRegistrationConfirmed } = require("../rabbitMQ/publishers/registration.events.publisher.js");

const app = require("../app");
const Event = require("../models/event.model.js");
const Course = require("../models/course.model.js");
const Registration = require("../models/registration.model.js");
const { handlePaymentStatusUpdated } = require("../rabbitMQ/listeners/payment.status.listener.js");

const TENANT = "64a0000000000000000000a1";
const USER_A = "payer-portal-a";
const USER_B = "payer-portal-b";
const CRM_USER = "payer-crm-1";

function bearer({ sub, tenantId = TENANT, userType }) {
  return `Bearer ${jwt.sign({ sub, tenantId, roles: [], userType }, process.env.JWT_SECRET)}`;
}
const portalA = () => bearer({ sub: USER_A, userType: "PORTAL" });
const crm = () => bearer({ sub: CRM_USER, userType: "CRM" });

function upstreamError(status, code, message = "upstream") {
  const err = new Error(message);
  err.isAxiosError = true;
  err.response = { status, data: { success: false, error: { code, message } } };
  return err;
}

let event;
let event2;
let course;
let counter = 0;
const body = (overrides = {}) => {
  counter += 1;
  return {
    registrationType: "event",
    eventId: String(event._id),
    paymentMethod: "stripe",
    profile: { email: `payer-${counter}@example.test`, firstName: "Ann", lastName: "A" },
    ...overrides,
  };
};
const ownPayment = (overrides = {}) => ({
  _id: "pay-own-1",
  purpose: "eventRegistration",
  amount: 8000,
  currency: "eur",
  registrationId: null,
  payer: { userId: USER_A, userType: "PORTAL" },
  target: { entityType: "event", entityId: String(event._id) },
  ...overrides,
});
const post = (auth, b) => request(app).post("/api/registrations").set("Authorization", auth).send(b);

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

beforeEach(async () => {
  const base = {
    title: "Payer event",
    startDate: new Date("2030-01-01T09:00:00Z"),
    endDate: new Date("2030-01-01T17:00:00Z"),
    status: "Published",
    memberPrice: 50,
    nonMemberPrice: 80,
    createdBy: CRM_USER,
  };
  event = await Event.create({ tenantId: TENANT, ...base });
  event2 = await Event.create({ tenantId: TENANT, ...base, title: "Other event" });
  course = await Course.create({ tenantId: TENANT, title: "Payer course", startDate: new Date("2030-02-01"), productId: "prod-course-1" });
  resolveLookupNamesByIds.mockResolvedValue(new Map());
  getActiveMembership.mockResolvedValue({ isActiveMember: false, membershipCategory: null });
  getCallerOwnProfile.mockResolvedValue(null);
  checkAttendeeDuplicates.mockResolvedValue({ resolution: "none" });
  getCurrentPriceForProduct.mockResolvedValue({ amount: 12000, currency: "eur" });
  attachRegistrationToPaymentIntent.mockImplementation(async ({ registrationId }) => ({
    ok: true, paymentId: "pay-own-1", registrationId, status: "requires_capture",
  }));
});

afterEach(async () => {
  await Promise.all([
    Event.deleteMany({ tenantId: TENANT }),
    Course.deleteMany({ tenantId: TENANT }),
    Registration.deleteMany({ tenantId: TENANT }),
  ]);
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("createRegistration with a pre-authorized PaymentIntent (PORTAL)", () => {
  it("A1 sends the registration's binding to the atomic attach and records the attach result", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment());
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_own_1" }));
    expect(res.status).toBe(201);
    const regId = res.body.data.registration._id;
    expect(attachRegistrationToPaymentIntent).toHaveBeenCalledTimes(1);
    expect(attachRegistrationToPaymentIntent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        paymentIntentId: "pi_own_1",
        registrationId: String(regId),
        entityType: "event",
        entityId: String(event._id),
        purpose: "eventRegistration",
        amount: 8000,
        currency: "eur",
      }),
    );
    const call = attachRegistrationToPaymentIntent.mock.calls[0][0];
    expect(call.profileId).toBeUndefined();
    expect(call.memberId).toBeUndefined();
    const reg = await Registration.findById(regId).lean();
    expect(reg.paymentId).toBe("pay-own-1");
    expect(reg.stripePaymentIntentId).toBe("pi_own_1");
    expect(reg.paymentStatus).toBe("authorized");
  });

  it("A2 another member's intent: account by-stripe 403 NOT_OWNER -> 403, no registration left", async () => {
    getPaymentByPaymentIntentId.mockRejectedValue(upstreamError(403, "NOT_OWNER", "Not permitted for this record"));
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_of_b" }));
    expect(res.status).toBe(403);
    expect(attachRegistrationToPaymentIntent).not.toHaveBeenCalled();
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });

  it("belt and braces: an intent whose payer is someone else is refused before attach", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment({ payer: { userId: USER_B, userType: "PORTAL" } }));
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_of_b" }));
    expect(res.status).toBe(403);
    expect(res.body.error?.code || res.body.code).toBe("NOT_OWNER");
    expect(attachRegistrationToPaymentIntent).not.toHaveBeenCalled();
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });

  it("A4 own intent made for another event (same price) is refused before attach, no registration left", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment({ target: { entityType: "event", entityId: String(event2._id) } }));
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_for_e2" }));
    expect(res.status).toBe(400);
    expect(attachRegistrationToPaymentIntent).not.toHaveBeenCalled();
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });

  it("A6 attach 409 (intent already bound) fails the registration cleanly - no orphan", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment());
    attachRegistrationToPaymentIntent.mockRejectedValue(upstreamError(409, "ALREADY_ATTACHED"));
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_own_1" }));
    expect(res.status).toBe(409);
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });

  it("A6 two concurrent registrations with one intent: exactly one survives, the other 409", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment());
    let boundTo = null; // emulates account-service's atomic single attach
    attachRegistrationToPaymentIntent.mockImplementation(async ({ registrationId }) => {
      await new Promise((r) => setTimeout(r, 5));
      if (boundTo && boundTo !== registrationId) throw upstreamError(409, "ALREADY_ATTACHED");
      boundTo = registrationId;
      return { ok: true, paymentId: "pay-own-1", registrationId, status: "requires_capture" };
    });
    const [r1, r2] = await Promise.all([
      post(portalA(), body({ stripePaymentIntentId: "pi_own_1" })),
      post(portalA(), body({ stripePaymentIntentId: "pi_own_1" })),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const regs = await Registration.find({ tenantId: TENANT }).lean();
    expect(regs).toHaveLength(1);
    expect(String(regs[0]._id)).toBe(boundTo);
  });

  it("A11 course: an intent made with purpose courseRegistration for the course attaches; the live portal's eventRegistration intent is refused (pre-existing purpose gap, unchanged)", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(
      ownPayment({ purpose: "courseRegistration", amount: 12000, target: { entityType: "course", entityId: String(course._id) } }),
    );
    const ok = await post(portalA(), body({ registrationType: "course", eventId: undefined, courseId: String(course._id), stripePaymentIntentId: "pi_course" }));
    expect(ok.status).toBe(201);
    expect(attachRegistrationToPaymentIntent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ entityType: "course", entityId: String(course._id), purpose: "courseRegistration" }),
    );
    await Registration.deleteMany({ tenantId: TENANT });
    attachRegistrationToPaymentIntent.mockClear();
    getPaymentByPaymentIntentId.mockResolvedValue(
      ownPayment({ purpose: "eventRegistration", amount: 12000, target: { entityType: "event", entityId: String(course._id) } }),
    );
    const bad = await post(portalA(), body({ registrationType: "course", eventId: undefined, courseId: String(course._id), stripePaymentIntentId: "pi_course_portal" }));
    expect(bad.status).toBe(400);
    expect(attachRegistrationToPaymentIntent).not.toHaveBeenCalled();
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });
});

describe("createRegistration stripe without a pre-authorized intent", () => {
  it("PORTAL: intent is created for the event (no registrationId) and then bound by attach", async () => {
    createRegistrationPaymentIntent.mockResolvedValue({ id: "pay-new-1", paymentIntentId: "pi_new_1", clientSecret: "pi_new_1_secret" });
    attachRegistrationToPaymentIntent.mockImplementation(async ({ registrationId }) => ({ ok: true, paymentId: "pay-new-1", registrationId, status: "requires_payment_method" }));
    const res = await post(portalA(), body());
    expect(res.status).toBe(201);
    const create = createRegistrationPaymentIntent.mock.calls[0][0];
    expect(create.registrationId).toBeUndefined();
    expect(create).toEqual(expect.objectContaining({ entityType: "event", entityId: String(event._id), purpose: "eventRegistration" }));
    expect(attachRegistrationToPaymentIntent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ paymentIntentId: "pi_new_1", registrationId: String(res.body.data.registration._id), entityType: "event" }),
    );
    expect(res.body.data.payment.clientSecret).toBe("pi_new_1_secret");
    const reg = await Registration.findById(res.body.data.registration._id).lean();
    expect(reg.paymentId).toBe("pay-new-1");
    expect(reg.stripePaymentIntentId).toBe("pi_new_1");
  });

  it("CRM: unchanged registration-backed intent; registration.paymentId comes from the response id", async () => {
    createRegistrationPaymentIntent.mockResolvedValue({ id: "pay-crm-1", paymentIntentId: "pi_crm_1", clientSecret: "pi_crm_1_secret" });
    const res = await post(crm(), body());
    expect(res.status).toBe(201);
    const create = createRegistrationPaymentIntent.mock.calls[0][0];
    expect(create.registrationId).toBe(String(res.body.data.registration._id));
    expect(attachRegistrationToPaymentIntent).not.toHaveBeenCalled();
    const reg = await Registration.findById(res.body.data.registration._id).lean();
    expect(reg.paymentId).toBe("pay-crm-1");
  });
});

describe("A13 payment.status.listener matches the registration's own payment", () => {
  async function victim(overrides = {}) {
    counter += 1;
    const email = `victim-${counter}@example.test`;
    return Registration.create({
      tenantId: TENANT,
      registrationType: "event",
      eventId: event._id,
      attendeeSnapshot: { email, normalizedEmail: email },
      amount: 8000,
      currency: "eur",
      paymentMethod: "stripe",
      paymentStatus: "pending",
      status: "pending",
      approvalStatus: "pending_review",
      registeredVia: "crm",
      isActive: true,
      paymentId: "pay-victim",
      stripePaymentIntentId: "pi_victim",
      ...overrides,
    });
  }
  const evt = (reg, data) => ({
    eventId: `evt-${Math.random()}`,
    tenantId: TENANT,
    data: { tenantId: TENANT, registrationId: String(reg._id), ...data },
  });
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it("another intent's status carrying the victim's registrationId changes nothing", async () => {
    const reg = await victim();
    for (const status of ["requires_capture", "failed", "succeeded"]) {
      await handlePaymentStatusUpdated(evt(reg, { paymentId: "pay-attacker", paymentIntentId: "pi_attacker", status }), {});
      await handlePaymentStatusUpdated(evt(reg, { paymentId: "pay-attacker", status }), {}); // old account payload
    }
    const fresh = await Registration.findById(reg._id).lean();
    expect(fresh.paymentStatus).toBe("pending");
    expect(fresh.status).toBe("pending");
    expect(publishRegistrationConfirmed).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => /PaymentRegistrationMismatch/.test(c[0]))).toBe(true);
  });

  it("the registration's own payment (by paymentId or paymentIntentId) still updates it", async () => {
    const reg = await victim();
    await handlePaymentStatusUpdated(evt(reg, { paymentId: "pay-victim", paymentIntentId: "pi_victim", status: "requires_capture" }), {});
    expect((await Registration.findById(reg._id).lean()).paymentStatus).toBe("authorized");
    // legacy CRM-created row (paymentId never backfilled) matched by the PaymentIntent id
    const legacy = await victim({ paymentId: null, stripePaymentIntentId: "pi_legacy_crm" });
    await handlePaymentStatusUpdated(evt(legacy, { paymentId: "pay-legacy", paymentIntentId: "pi_legacy_crm", status: "requires_capture" }), {});
    expect((await Registration.findById(legacy._id).lean()).paymentStatus).toBe("authorized");
  });

  it("legacy row without paymentId + event without paymentIntentId (pre-P5 account) is not trusted", async () => {
    const legacy = await victim({ paymentId: null, stripePaymentIntentId: "pi_legacy_crm2" });
    await handlePaymentStatusUpdated(evt(legacy, { paymentId: "pay-unknown", status: "requires_capture" }), {});
    expect((await Registration.findById(legacy._id).lean()).paymentStatus).toBe("pending");
  });

  it("a superseded intent (retry-payment replaced it) cannot flip the registration", async () => {
    const reg = await victim({ paymentId: "pay-new", stripePaymentIntentId: "pi_new" });
    await handlePaymentStatusUpdated(evt(reg, { paymentId: "pay-old", paymentIntentId: "pi_old", status: "failed" }), {});
    expect((await Registration.findById(reg._id).lean()).paymentStatus).toBe("pending");
  });
});

// ---------------------------------------------------------------- P5 batch 5: one binding per registration
describe("B registration payment binding is set once; replacement is one conditional transition", () => {
  const { voidManualRegistrationPayment } = require("../services/accountService.client.js");
  async function pendingStripeReg(overrides = {}) {
    counter += 1;
    return Registration.create({
      tenantId: TENANT,
      registrationType: "event",
      eventId: event._id,
      approvalStatus: "pending_review",
      attendeeSnapshot: { email: `b-${counter}@example.test`, normalizedEmail: `b-${counter}@example.test` },
      amount: 8000,
      currency: "eur",
      paymentMethod: "stripe",
      paymentStatus: "pending",
      status: "pending",
      paymentId: "pay-old",
      stripePaymentIntentId: "pi_old",
      registeredVia: "crm",
      ...overrides,
    });
  }
  const retry = (id) => request(app).post(`/api/registrations/${id}/retry-payment`).set("Authorization", crm()).send({});

  it("B1 two concurrent CRM retries that get DIFFERENT intents: one 200, one 409; one binding survives", async () => {
    const reg = await pendingStripeReg();
    let n = 0;
    createRegistrationPaymentIntent.mockImplementation(async () => {
      n += 1;
      const k = n;
      await new Promise((r) => setTimeout(r, 5));
      return { id: `pay-new-${k}`, paymentIntentId: `pi_new_${k}`, clientSecret: `pi_new_${k}_secret`, status: "requires_action" };
    });
    const rs = await Promise.all([retry(reg._id), retry(reg._id)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = rs.find((r) => r.status === 409);
    expect(loser.body.error?.code || loser.body.code).toBe("REGISTRATION_PAYMENT_CHANGED");
    expect(JSON.stringify(loser.body)).not.toMatch(/_secret/);
    const winner = rs.find((r) => r.status === 200);
    const after = await Registration.findById(reg._id).lean();
    expect(after.stripePaymentIntentId).toBe(winner.body.data.paymentIntentId);
    expect(after.paymentId).toBe(winner.body.data.paymentIntentId.replace("pi_new_", "pay-new-"));
  });

  it("B2 concurrent retries that get the SAME reused intent are idempotent (both 200)", async () => {
    const reg = await pendingStripeReg();
    createRegistrationPaymentIntent.mockResolvedValue({ id: "pay-r", paymentIntentId: "pi_r", clientSecret: "pi_r_secret", status: "requires_action" });
    const rs = await Promise.all([retry(reg._id), retry(reg._id)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const after = await Registration.findById(reg._id).lean();
    expect([after.paymentId, after.stripePaymentIntentId]).toEqual(["pay-r", "pi_r"]);
  });

  it("B3 binding changed between read and write -> 409, nothing overwritten, superseded manual payment NOT voided", async () => {
    const reg = await pendingStripeReg({ paymentMethod: "manual", paymentId: "manual-1", stripePaymentIntentId: null });
    createRegistrationPaymentIntent.mockImplementation(async () => {
      await Registration.updateOne({ _id: reg._id }, { $set: { paymentId: "pay-concurrent", stripePaymentIntentId: "pi_concurrent" } });
      return { id: "pay-mine", paymentIntentId: "pi_mine", clientSecret: "pi_mine_secret", status: "requires_action" };
    });
    const r = await retry(reg._id);
    expect(r.status).toBe(409);
    expect(voidManualRegistrationPayment).not.toHaveBeenCalled();
    const after = await Registration.findById(reg._id).lean();
    expect([after.paymentId, after.stripePaymentIntentId]).toEqual(["pay-concurrent", "pi_concurrent"]);
  });

  it("B4 account refuses a replacement while the holder holds funds (409 REGISTRATION_PAYMENT_HELD) -> 409, registration unchanged", async () => {
    const reg = await pendingStripeReg({ paymentStatus: "authorized" });
    createRegistrationPaymentIntent.mockRejectedValue(upstreamError(409, "REGISTRATION_PAYMENT_HELD"));
    const r = await retry(reg._id);
    expect(r.status).toBe(409);
    const after = await Registration.findById(reg._id).lean();
    expect([after.paymentId, after.stripePaymentIntentId, after.paymentStatus]).toEqual(["pay-old", "pi_old", "authorized"]);
  });

  it("B6 account fails closed on an ambiguous legacy registration (409 REGISTRATION_BINDING_AMBIGUOUS) -> 409 passthrough, registration unchanged, nothing voided", async () => {
    const reg = await pendingStripeReg({ paymentMethod: "manual", paymentId: "manual-amb", stripePaymentIntentId: null });
    createRegistrationPaymentIntent.mockRejectedValue(upstreamError(409, "REGISTRATION_BINDING_AMBIGUOUS"));
    const r = await retry(reg._id);
    expect(r.status).toBe(409);
    expect(r.body.error?.code || r.body.code).toBe("REGISTRATION_BINDING_AMBIGUOUS");
    expect(voidManualRegistrationPayment).not.toHaveBeenCalled();
    const after = await Registration.findById(reg._id).lean();
    expect([after.paymentMethod, after.paymentId, after.stripePaymentIntentId]).toEqual(["manual", "manual-amb", null]);
  });

  it("B7 an orphaned/losing intent refused by account at attach (409 INTENT_ORPHANED) -> 409, registration rolled back, no secret", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment());
    attachRegistrationToPaymentIntent.mockRejectedValue(upstreamError(409, "INTENT_ORPHANED"));
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_orphan_1" }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/_secret/);
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });

  it("B5 createRegistration never overwrites a binding that appeared concurrently -> 409, registration rolled back", async () => {
    getPaymentByPaymentIntentId.mockResolvedValue(ownPayment());
    attachRegistrationToPaymentIntent.mockImplementation(async ({ registrationId }) => {
      await Registration.updateOne({ _id: registrationId }, { $set: { paymentId: "pay-someone-else" } });
      return { ok: true, paymentId: "pay-own-1", registrationId, status: "requires_capture" };
    });
    const res = await post(portalA(), body({ stripePaymentIntentId: "pi_own_1" }));
    expect(res.status).toBe(409);
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
  });
});
