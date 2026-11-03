/**
 * P5 STUDENT policy - member-facing claim view (exact response schema).
 * Portal / self responses carry only { source, institution, verification: { status } } for a student
 * claim: never the verifier's user id, the verification method/time or the staff note. CRM staff
 * views keep the full record. Harness copied from studentPolicy.p5.test.js.
 * (original header follows)
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
const PORTAL_USER = "p5stuview-portal-a";
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
    profile: { email: `p5stuview-${counter}@example.test`, firstName: "Ann", lastName: "A" },
    ...overrides,
  };
}
function makeRegistration(overrides = {}) {
  counter += 1;
  const email = `p5stuview-row-${counter}@example.test`;
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


const { memberFacingStudentEligibility } = require("../services/studentEligibility.service.js");

const STAFF_NOTE = "P5-STAFF-NOTE-SENTINEL";
const VERIFIER = "64c000000000000000000c99";
const decidedClaim = (status) => ({
  source: "declared_claim",
  institution: "Example University",
  declaredAt: new Date(),
  verification: { status, method: "crm", byUserId: VERIFIER, at: new Date(), note: STAFF_NOTE },
});
const MEMBER_KEYS = ["institution", "source", "verification"];
function expectMemberView(se) {
  expect(Object.keys(se).sort()).toEqual(MEMBER_KEYS);
  expect(Object.keys(se.verification)).toEqual(["status"]);
}
function expectNoStaffFields(res) {
  const text = JSON.stringify(res.body);
  expect(text).not.toContain(STAFF_NOTE);
  expect(text).not.toContain(VERIFIER);
  expect(text).not.toContain("byUserId");
  expect(text).not.toMatch(/"method"\s*:\s*"crm"/);
}

describe("memberFacingStudentEligibility (exact shape)", () => {
  it("keeps only source, institution and verification.status", () => {
    const out = memberFacingStudentEligibility(decidedClaim("verified"));
    expect(out).toEqual({ source: "declared_claim", institution: "Example University", verification: { status: "verified" } });
  });
  it("null / non-object / unknown source -> null", () => {
    expect(memberFacingStudentEligibility(null)).toBeNull();
    expect(memberFacingStudentEligibility("x")).toBeNull();
    expect(memberFacingStudentEligibility({ source: "staff_override", verification: { status: "verified" } })).toBeNull();
  });
  it("missing institution / verification -> explicit nulls, no extra keys", () => {
    expect(memberFacingStudentEligibility({ source: "verified_membership" })).toEqual({
      source: "verified_membership",
      institution: null,
      verification: { status: null },
    });
  });
});

describe("portal-facing responses carry the member-facing claim view only", () => {
  it("GET /mine: rejected claim with staff note and verifier -> exact member keys, no staff fields", async () => {
    await makeRegistration({ studentEligibility: decidedClaim("rejected"), status: "cancelled", approvalStatus: "rejected", isActive: false });
    const res = await send("get", "/api/registrations/mine", portal());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expectMemberView(res.body.data[0].studentEligibility);
    expect(res.body.data[0].studentEligibility).toEqual({
      source: "declared_claim",
      institution: "Example University",
      verification: { status: "rejected" },
    });
    expectNoStaffFields(res);
  });

  it("GET /mine: a registration without a claim keeps studentEligibility null", async () => {
    await makeRegistration({ priceCategory: "standard", priceBreakdown: [] });
    const res = await send("get", "/api/registrations/mine", portal());
    expect(res.status).toBe(200);
    expect(res.body.data[0].studentEligibility ?? null).toBeNull();
  });

  it("GET /mine as a CRM user (own registrations) is also the member view", async () => {
    await makeRegistration({ submittedByUserId: CRM_USER, studentEligibility: decidedClaim("verified") });
    const res = await send("get", "/api/registrations/mine", crm());
    expect(res.status).toBe(200);
    expectMemberView(res.body.data[0].studentEligibility);
    expectNoStaffFields(res);
  });

  it("GET /:id as the PORTAL owner -> member view; as CRM -> full staff record", async () => {
    const reg = await makeRegistration({ studentEligibility: decidedClaim("verified") });
    const own = await send("get", `/api/registrations/${reg._id}`, portal());
    expect(own.status).toBe(200);
    expectMemberView(own.body.data.studentEligibility);
    expectNoStaffFields(own);

    const staff = await send("get", `/api/registrations/${reg._id}`, crm());
    expect(staff.status).toBe(200);
    expect(staff.body.data.studentEligibility.verification).toMatchObject({
      status: "verified",
      method: "crm",
      byUserId: VERIFIER,
      note: STAFF_NOTE,
    });
  });

  it("PUT /:id/cancel by the PORTAL owner -> member view in the response", async () => {
    const reg = await makeRegistration({ studentEligibility: decidedClaim("verified") });
    const res = await send("put", `/api/registrations/${reg._id}/cancel`, portal());
    expect(res.status).toBe(200);
    expectMemberView(res.body.data.studentEligibility);
    expectNoStaffFields(res);
    // stored record unchanged
    const row = await Registration.findById(reg._id).lean();
    expect(row.studentEligibility.verification.note).toBe(STAFF_NOTE);
  });

  it("POST / (portal claim) -> 201 with exactly the member view of the new pending claim", async () => {
    const res = await send("post", "/api/registrations", portal(), {
      body: createBody({ lineItems: [{ tierKey: "STUDENT", quantity: 1 }], studentClaim: { institution: "Example University" } }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.registration.studentEligibility).toEqual({
      source: "declared_claim",
      institution: "Example University",
      verification: { status: "pending" },
    });
  });
});
