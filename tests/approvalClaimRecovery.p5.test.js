/**
 * P5 S2: an approval/reject claim left in "processing" by a request that died before it could
 * finish or release must not become an unrecoverable stuck approval. Only the SAME decision may take
 * over its own stale claim; the opposite decision, a fresh claim, or a legacy claim with no recorded
 * decision are never taken over. Re-running the action reuses the deterministic payment command, so
 * account's idempotent replay is what makes the takeover safe (no second Stripe/GL mutation).
 */
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../services/accountService.client.js");
jest.mock("../services/profileLookup.client.js");

const { capturePaymentIntent } = require("../services/accountService.client.js");
const { getProfileMembershipNumber, updateAttendeeProfileFields } = require("../services/profileLookup.client.js");

const app = require("../app");
const Registration = require("../models/registration.model.js");
const {
  APPROVAL_CLAIM_STALE_MS,
  claimRegistrationForApproval,
} = require("../services/registrationApproval.service.js");

const TENANT_ID = "tenant-claim-recovery-p5";

function authHeader() {
  const token = jwt.sign({ sub: "user-1", tenantId: TENANT_ID, userType: "CRM", roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

function processingClaim(action, ageMs) {
  return {
    approvalStatus: "processing",
    paymentDecision: { action, actorUserId: "crm-1", claimedAt: new Date(Date.now() - ageMs) },
  };
}

async function createRegistration(overrides = {}) {
  return Registration.create({
    tenantId: TENANT_ID,
    registrationType: "event",
    eventId: new mongoose.Types.ObjectId(),
    approvalStatus: "pending_review",
    duplicateReview: { status: "EXACT_MATCH", matchedProfileId: "profile-1" },
    attendeeSnapshot: { email: "attendee@example.com", normalizedEmail: "attendee@example.com" },
    amount: 5000,
    currency: "eur",
    paymentMethod: "stripe",
    paymentStatus: "authorized",
    status: "pending",
    stripePaymentIntentId: "pi_claim_recovery",
    paymentId: String(new mongoose.Types.ObjectId()),
    registeredVia: "crm",
    ...overrides,
  });
}

const STALE = APPROVAL_CLAIM_STALE_MS + 60 * 1000;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(async () => {
  await Registration.deleteMany({ tenantId: TENANT_ID });
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("claimRegistrationForApproval - stale claim takeover", () => {
  it("claims a pending_review registration as before", async () => {
    const reg = await createRegistration();
    const claimed = await claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "approve" });
    expect(claimed.approvalStatus).toBe("processing");
    expect(claimed.paymentDecision.action).toBe("approve");
  });

  it("the same decision takes over its own stale claim (refreshing claimedAt)", async () => {
    const reg = await createRegistration(processingClaim("approve", STALE));
    const before = reg.paymentDecision.claimedAt.getTime();
    const claimed = await claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "approve" });
    expect(claimed).not.toBeNull();
    expect(claimed.paymentDecision.action).toBe("approve");
    expect(claimed.paymentDecision.claimedAt.getTime()).toBeGreaterThan(before);
  });

  it("a fresh (in-flight) claim is never taken over, even by the same decision", async () => {
    const reg = await createRegistration(processingClaim("approve", 30 * 1000));
    expect(await claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "approve" })).toBeNull();
  });

  it("the opposite decision never takes over a stale claim", async () => {
    const reg = await createRegistration(processingClaim("approve", STALE));
    expect(await claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "reject" })).toBeNull();
    const regR = await createRegistration(processingClaim("reject", STALE));
    expect(await claimRegistrationForApproval({ id: regR._id, tenantId: TENANT_ID, action: "approve" })).toBeNull();
  });

  it("a legacy processing claim with no recorded decision is not taken over", async () => {
    const reg = await createRegistration({ approvalStatus: "processing" });
    expect(await claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "approve" })).toBeNull();
  });

  it("another tenant cannot take over the claim", async () => {
    const reg = await createRegistration(processingClaim("approve", STALE));
    expect(await claimRegistrationForApproval({ id: reg._id, tenantId: "other-tenant", action: "approve" })).toBeNull();
  });

  it("concurrent takeovers of one stale claim: exactly one wins", async () => {
    const reg = await createRegistration(processingClaim("approve", STALE));
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "approve" })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("concurrent approve vs reject on pending_review: exactly one decision is claimed", async () => {
    const reg = await createRegistration();
    const [a, r] = await Promise.all([
      claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "approve" }),
      claimRegistrationForApproval({ id: reg._id, tenantId: TENANT_ID, action: "reject" }),
    ]);
    expect([a, r].filter(Boolean)).toHaveLength(1);
    const stored = await Registration.findById(reg._id).lean();
    expect(stored.paymentDecision.action).toBe(a ? "approve" : "reject");
  });
});

describe("PUT /registrations/:id/approve - recovery after a request died mid-approval", () => {
  beforeEach(() => {
    getProfileMembershipNumber.mockResolvedValue("M-1");
    updateAttendeeProfileFields.mockResolvedValue({ updated: true, profileId: "profile-1" });
  });

  it("a stuck stale approve claim is recovered by re-running approve; account replays (no second capture effect)", async () => {
    const reg = await createRegistration(processingClaim("approve", STALE));
    // Account already captured before the original request died: the replay reports it.
    capturePaymentIntent.mockResolvedValue({ status: "succeeded", alreadyCaptured: true });

    const res = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(capturePaymentIntent.mock.calls[0][0]).toMatchObject({ paymentIntentId: "pi_claim_recovery" });
    const stored = await Registration.findById(reg._id).lean();
    expect(stored.approvalStatus).toBe("approved");
    expect(stored.status).toBe("confirmed");
  });

  it("a fresh in-flight approve claim still blocks a second approve (no double processing)", async () => {
    const reg = await createRegistration(processingClaim("approve", 30 * 1000));
    const res = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect((await Registration.findById(reg._id).lean()).approvalStatus).toBe("processing");
  });

  it("a stale approve claim is not recovered by reject (the approve may already have moved money)", async () => {
    const reg = await createRegistration(processingClaim("approve", STALE));
    const res = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", authHeader());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await Registration.findById(reg._id).lean()).paymentDecision.action).toBe("approve");
  });

  it("timeout after account success, then retry: claim released, retry replays the same command and confirms once", async () => {
    const reg = await createRegistration();
    const timeout = Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED", isAxiosError: true });
    capturePaymentIntent.mockRejectedValueOnce(timeout).mockResolvedValueOnce({ status: "succeeded", alreadyCaptured: true });

    const first = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect((await Registration.findById(reg._id).lean()).approvalStatus).toBe("pending_review");

    const second = await request(app).put(`/api/registrations/${reg._id}/approve`).set("Authorization", authHeader());
    expect(second.status).toBe(200);
    expect(capturePaymentIntent).toHaveBeenCalledTimes(2);
    const [c1, c2] = capturePaymentIntent.mock.calls.map((c) => c[0]);
    expect(c2.paymentIntentId).toBe(c1.paymentIntentId);
    expect(c2.command).toEqual(c1.command); // deterministic command -> same canonical key on account
    expect((await Registration.findById(reg._id).lean()).status).toBe("confirmed");
  });
});
