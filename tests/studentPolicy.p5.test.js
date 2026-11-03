/**
 * P5 STUDENT policy (server enforcement).
 * STUDENT pricing needs the caller's verified undergraduate-student membership
 * OR an institution declaration that a CRM user verifies before approval /
 * capture; rejecting the claim rejects the registration; GROUP_STUDENT is
 * CRM-only; a membership lookup error is a 503 (see also
 * subscriptionLookup.failClosed.p5.test.js for the client itself).
 * Synthetic ids and values only.
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
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");

const {
  createRegistrationPaymentIntent,
  postManualRegistrationPayment,
  capturePaymentIntent,
  postManualRegistrationPaymentToGL,
  cancelPaymentIntent,
  voidManualRegistrationPayment,
} = require("../services/accountService.client.js");
const {
  getCallerOwnProfile,
  checkAttendeeDuplicates,
  getProfileMembershipNumber,
  findOrCreateAttendeeProfile,
} = require("../services/profileLookup.client.js");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");
const { resolveLookupNamesByIds } = require("../services/lookup.client.js");
const {
  publishRegistrationConfirmed,
  publishRegistrationCancelled,
} = require("../rabbitMQ/publishers/registration.events.publisher.js");
const { AppError } = require("../errors/AppError.js");

const app = require("../app");
const Event = require("../models/event.model.js");
const Registration = require("../models/registration.model.js");
const { handlePaymentStatusUpdated } = require("../rabbitMQ/listeners/payment.status.listener.js");

const TENANT = "64c0000000000000000000a1";
const OTHER_TENANT = "64c0000000000000000000b2";
const PORTAL_USER = "p5stu-portal-a";
const CRM_USER = "64c000000000000000000c01";

function bearer({ sub, tenantId = TENANT, userType }) {
  return `Bearer ${jwt.sign({ sub, tenantId, roles: [], userType }, process.env.JWT_SECRET)}`;
}
const portal = () => bearer({ sub: PORTAL_USER, userType: "PORTAL" });
const crm = (tenantId = TENANT) => bearer({ sub: CRM_USER, userType: "CRM", tenantId });

function send(method, path, auth, { body, headers = {} } = {}) {
  let req = request(app)[method](path).set("Authorization", auth);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return body ? req.send(body) : req;
}
const code = (res) => res.body?.error?.code || res.body?.code;

let event;
let counter = 0;
function createBody(overrides = {}) {
  counter += 1;
  return {
    registrationType: "event",
    eventId: String(event._id),
    paymentMethod: "stripe",
    profile: { email: `p5stu-${counter}@example.test`, firstName: "Ann", lastName: "A" },
    ...overrides,
  };
}
function makeRegistration(overrides = {}) {
  counter += 1;
  const email = `p5stu-row-${counter}@example.test`;
  return Registration.create({
    tenantId: TENANT,
    registrationType: "event",
    eventId: event._id,
    attendeeSnapshot: { email, normalizedEmail: email },
    duplicateReview: { status: "EXACT_MATCH", matchedProfileId: "profile-1" },
    amount: 2000,
    currency: "eur",
    priceCategory: "student",
    priceBreakdown: [{ tierKey: "STUDENT", quantity: 1, unitPrice: 20 }],
    paymentMethod: "stripe",
    paymentStatus: "authorized",
    stripePaymentIntentId: `pi_stu_${counter}`,
    status: "pending",
    approvalStatus: "pending_review",
    registeredVia: "portal",
    submittedByUserId: PORTAL_USER,
    isActive: true,
    ...overrides,
  });
}
const pendingClaim = () => ({
  source: "declared_claim",
  institution: "Example University",
  declaredAt: new Date(),
  verification: { status: "pending" },
});

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

beforeEach(async () => {
  event = await Event.create({
    tenantId: TENANT,
    title: "Student event",
    startDate: new Date("2030-01-01T09:00:00Z"),
    endDate: new Date("2030-01-01T17:00:00Z"),
    status: "Published",
    memberPrice: 50,
    nonMemberPrice: 80,
    createdBy: CRM_USER,
    pricingTiers: [
      { tierType: "STUDENT", price: 20 },
      { tierType: "GROUP_STUDENT", price: 15, minGroupSize: 2 },
    ],
  });
  resolveLookupNamesByIds.mockResolvedValue(new Map());
  getActiveMembership.mockResolvedValue({ isActiveMember: false, membershipCategory: null });
  getCallerOwnProfile.mockResolvedValue(null);
  checkAttendeeDuplicates.mockResolvedValue({ resolution: "none" });
  getProfileMembershipNumber.mockResolvedValue(null);
  findOrCreateAttendeeProfile.mockResolvedValue({ profileId: "profile-new", membershipNumber: null, created: true });
  createRegistrationPaymentIntent.mockResolvedValue({ paymentId: "pay-1", paymentIntentId: "pi_new", clientSecret: "pi_new_secret" });
  postManualRegistrationPayment.mockResolvedValue({ paymentId: "pay-manual-1" });
  capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
  postManualRegistrationPaymentToGL.mockResolvedValue({});
  cancelPaymentIntent.mockResolvedValue({});
  voidManualRegistrationPayment.mockResolvedValue({});
});

afterEach(async () => {
  await Promise.all([
    Event.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } }),
    Registration.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } }),
  ]);
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("PORTAL create: student tiers are server-checked", () => {
  it("non-member STUDENT without an institution declaration -> 400 STUDENT_CLAIM_REQUIRED, nothing created or charged", async () => {
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({ lineItems: [{ tierKey: "STUDENT", quantity: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect(code(res)).toBe("STUDENT_CLAIM_REQUIRED");
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });

  it("non-member STUDENT with an institution -> 201, claim recorded as pending verification", async () => {
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({
        lineItems: [{ tierKey: "STUDENT", quantity: 1 }],
        studentClaim: { institution: "  Example \n University  " },
      }),
    });
    expect(res.status).toBe(201);
    const row = await Registration.findById(res.body.data.registration._id).lean();
    expect(row.amount).toBe(2000);
    expect(row.studentEligibility.source).toBe("declared_claim");
    expect(row.studentEligibility.institution).toBe("Example University");
    expect(row.studentEligibility.verification.status).toBe("pending");
  });

  it("verified undergraduate-student member STUDENT -> 201, verified by membership (no CRM step)", async () => {
    getCallerOwnProfile.mockResolvedValue({ profileId: "profile-a", membershipNumber: "M-A" });
    getActiveMembership.mockResolvedValue({ isActiveMember: true, membershipCategory: "Undergraduate Student" });
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({ lineItems: [{ tierKey: "STUDENT", quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    const row = await Registration.findById(res.body.data.registration._id).lean();
    expect(row.studentEligibility.source).toBe("verified_membership");
    expect(row.studentEligibility.verification).toMatchObject({ status: "verified", method: "membership" });
  });

  it.each([
    ["non-member", { isActiveMember: false, membershipCategory: null }],
    ["undergraduate-student member", { isActiveMember: true, membershipCategory: "Undergraduate Student" }],
  ])("%s choosing GROUP_STUDENT -> 403 GROUP_STUDENT_CRM_ONLY, nothing created", async (_l, membership) => {
    getActiveMembership.mockResolvedValue(membership);
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({
        lineItems: [{ tierKey: "GROUP_STUDENT", quantity: 3 }],
        studentClaim: { institution: "Example University" },
      }),
    });
    expect(res.status).toBe(403);
    expect(code(res)).toBe("GROUP_STUDENT_CRM_ONLY");
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });

  it("STUDENT for more than the caller's own seat -> 400 STUDENT_SINGLE_SEAT", async () => {
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({
        lineItems: [{ tierKey: "STUDENT", quantity: 2 }],
        studentClaim: { institution: "Example University" },
      }),
    });
    expect(res.status).toBe(400);
    expect(code(res)).toBe("STUDENT_SINGLE_SEAT");
  });

  it("active non-student member choosing STUDENT -> 400 TIER_NOT_ELIGIBLE (unchanged)", async () => {
    getActiveMembership.mockResolvedValue({ isActiveMember: true, membershipCategory: "General" });
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({ lineItems: [{ tierKey: "STUDENT", quantity: 1 }], studentClaim: { institution: "Example University" } }),
    });
    expect(res.status).toBe(400);
    expect(code(res)).toBe("TIER_NOT_ELIGIBLE");
  });

  it("membership lookup failure -> 503 MEMBERSHIP_LOOKUP_FAILED, nothing created or charged", async () => {
    getCallerOwnProfile.mockResolvedValue({ profileId: "profile-a", membershipNumber: "M-A" });
    getActiveMembership.mockRejectedValue(new AppError("Unable to verify membership", 503, "MEMBERSHIP_LOOKUP_FAILED"));
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({ lineItems: [{ tierKey: "STUDENT", quantity: 1 }], studentClaim: { institution: "Example University" } }),
    });
    expect(res.status).toBe(503);
    expect(code(res)).toBe("MEMBERSHIP_LOOKUP_FAILED");
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(0);
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });

  it("legacy (no lineItems) path: verified student member booking 2 seats never auto-derives group_student", async () => {
    getCallerOwnProfile.mockResolvedValue({ profileId: "profile-a", membershipNumber: "M-A" });
    getActiveMembership.mockResolvedValue({ isActiveMember: true, membershipCategory: "Undergraduate Student" });
    const two = await send("post", "/api/registrations", portal(), { body: createBody({ quantity: 2 }) });
    expect(two.status).toBe(201);
    const rowTwo = await Registration.findById(two.body.data.registration._id).lean();
    expect(rowTwo.priceCategory).toBe("standard");
    expect(rowTwo.studentEligibility).toBeNull();
    await Registration.deleteMany({ tenantId: TENANT });
    const one = await send("post", "/api/registrations", portal(), { body: createBody({ quantity: 1 }) });
    const rowOne = await Registration.findById(one.body.data.registration._id).lean();
    expect(rowOne.priceCategory).toBe("student");
    expect(rowOne.studentEligibility.source).toBe("verified_membership");
  });
});

describe("CRM create: student tiers are a recorded staff decision", () => {
  it("CRM GROUP_STUDENT -> 201, crm_assigned and verified by the CRM user", async () => {
    const res = await send("post", "/api/registrations", crm(), {
      body: createBody({ paymentMethod: "manual", lineItems: [{ tierKey: "GROUP_STUDENT", quantity: 3 }] }),
    });
    expect(res.status).toBe(201);
    const row = await Registration.findById(res.body.data.registration._id).lean();
    expect(row.studentEligibility).toMatchObject({
      source: "crm_assigned",
      verification: { status: "verified", method: "crm", byUserId: CRM_USER },
    });
  });
});

describe("approval / capture is blocked until the claim is verified", () => {
  it("stripe: pending claim -> 409 STUDENT_VERIFICATION_PENDING, no capture, no profile write, claim released", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    const res = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(res.status).toBe(409);
    expect(code(res)).toBe("STUDENT_VERIFICATION_PENDING");
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(findOrCreateAttendeeProfile).not.toHaveBeenCalled();
    expect(getProfileMembershipNumber).not.toHaveBeenCalled();
    const fresh = await Registration.findById(reg._id).lean();
    expect(fresh.approvalStatus).toBe("pending_review");
    expect(fresh.status).toBe("pending");
  });

  it("manual: pending claim -> 409, nothing posted to the GL", async () => {
    const reg = await makeRegistration({
      studentEligibility: pendingClaim(),
      paymentMethod: "manual",
      paymentStatus: "pending",
      paymentId: "pay-manual-x",
      stripePaymentIntentId: null,
    });
    const res = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(res.status).toBe(409);
    expect(postManualRegistrationPaymentToGL).not.toHaveBeenCalled();
  });

  it("pre-policy portal student row (no record) is treated as unverified -> 409", async () => {
    const reg = await makeRegistration();
    const res = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(res.status).toBe(409);
    expect(code(res)).toBe("STUDENT_VERIFICATION_PENDING");
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("pre-policy CRM student row (staff choice) still approves", async () => {
    const reg = await makeRegistration({ registeredVia: "crm", submittedByUserId: CRM_USER });
    const res = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(res.status).toBe(200);
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("verified claim -> approve captures and confirms", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    const v = await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "verify", note: "card seen" } });
    expect(v.status).toBe(200);
    const res = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(res.status).toBe(200);
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    const fresh = await Registration.findById(reg._id).lean();
    expect(fresh.approvalStatus).toBe("approved");
    expect(fresh.studentEligibility.verification).toMatchObject({ status: "verified", method: "crm", byUserId: CRM_USER, note: "card seen" });
  });

  it("standard (non-student) registration approval is unaffected", async () => {
    const reg = await makeRegistration({ priceCategory: "standard", priceBreakdown: [] });
    const res = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(res.status).toBe(200);
  });
});

describe("rejecting the claim rejects the registration", () => {
  it("reject -> authorization released, registration rejected/cancelled/inactive, later approve impossible", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    const res = await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "reject" } });
    expect(res.status).toBe(200);
    expect(cancelPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: reg.stripePaymentIntentId }));
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(publishRegistrationCancelled).toHaveBeenCalledTimes(1);
    const fresh = await Registration.findById(reg._id).lean();
    expect(fresh).toMatchObject({ approvalStatus: "rejected", status: "cancelled", isActive: false });
    expect(fresh.studentEligibility.verification).toMatchObject({ status: "rejected", byUserId: CRM_USER });
    const again = await send("put", `/api/registrations/${reg._id}/approve`, crm());
    expect(again.status).toBe(400);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("manual payment: reject voids the unposted payment", async () => {
    const reg = await makeRegistration({
      studentEligibility: pendingClaim(),
      paymentMethod: "manual",
      paymentId: "pay-manual-y",
      stripePaymentIntentId: null,
    });
    const res = await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "reject" } });
    expect(res.status).toBe(200);
    expect(voidManualRegistrationPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "pay-manual-y" }));
  });

  it("payment release failure -> registration stays pending and the claim undecided", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    cancelPaymentIntent.mockRejectedValue(Object.assign(new Error("upstream"), { response: { status: 502 } }));
    const res = await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "reject" } });
    expect(res.status).toBe(502);
    const fresh = await Registration.findById(reg._id).lean();
    expect(fresh).toMatchObject({ approvalStatus: "pending_review", status: "pending", isActive: true });
    expect(fresh.studentEligibility.verification.status).toBe("pending");
  });
});

describe("PUT /:id/student-verification gate and state", () => {
  it("PORTAL caller -> 403 CRM_ONLY; CRM without events:write -> 403; nothing decided", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    let res = await send("put", `/api/registrations/${reg._id}/student-verification`, portal(), { body: { decision: "verify" } });
    expect(res.status).toBe(403);
    res = await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), {
      body: { decision: "verify" },
      headers: { "x-test-pdp-deny": "events:write" },
    });
    expect(res.status).toBe(403);
    expect((await Registration.findById(reg._id).lean()).studentEligibility.verification.status).toBe("pending");
  });

  it("other tenant -> 404; invalid decision -> 400; no claim -> 409 NOT_REQUIRED; decided twice -> 409", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    expect((await send("put", `/api/registrations/${reg._id}/student-verification`, crm(OTHER_TENANT), { body: { decision: "verify" } })).status).toBe(404);
    expect((await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "approve" } })).status).toBe(400);
    const std = await makeRegistration({ priceCategory: "standard", priceBreakdown: [] });
    const nr = await send("put", `/api/registrations/${std._id}/student-verification`, crm(), { body: { decision: "verify" } });
    expect(nr.status).toBe(409);
    expect(code(nr)).toBe("STUDENT_VERIFICATION_NOT_REQUIRED");
    expect((await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "verify" } })).status).toBe(200);
    const twice = await send("put", `/api/registrations/${reg._id}/student-verification`, crm(), { body: { decision: "reject" } });
    expect(twice.status).toBe(409);
    expect(code(twice)).toBe("STUDENT_VERIFICATION_ALREADY_DECIDED");
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("concurrent verify and reject -> exactly one decision applies", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    const path = `/api/registrations/${reg._id}/student-verification`;
    const [a, b] = await Promise.all([
      send("put", path, crm(), { body: { decision: "verify" } }),
      send("put", path, crm(), { body: { decision: "reject" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const fresh = await Registration.findById(reg._id).lean();
    if (fresh.studentEligibility.verification.status === "verified") {
      expect(fresh.approvalStatus).toBe("pending_review");
      expect(cancelPaymentIntent).not.toHaveBeenCalled();
    } else {
      expect(fresh.approvalStatus).toBe("rejected");
    }
  });
});

describe("a capture outside approval never confirms an unverified claim", () => {
  it("payment succeeded event for a pending claim -> paymentStatus recorded, registration stays pending, no confirm", async () => {
    const reg = await makeRegistration({ studentEligibility: pendingClaim() });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await handlePaymentStatusUpdated(
      { eventId: "evt-1", tenantId: TENANT, data: { registrationId: String(reg._id), status: "succeeded", tenantId: TENANT } },
      { headers: { "x-tenant-id": TENANT } },
    );
    warn.mockRestore();
    const fresh = await Registration.findById(reg._id).lean();
    expect(fresh.paymentStatus).toBe("succeeded");
    expect(fresh.status).toBe("pending");
    expect(publishRegistrationConfirmed).not.toHaveBeenCalled();
  });
});
