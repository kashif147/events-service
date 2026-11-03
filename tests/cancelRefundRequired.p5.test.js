/**
 * P5 (#29 contract): account-service's PaymentIntent cancel can answer HTTP 200 with
 * status "refund_required" when the intent had already been captured at Stripe. That is an
 * intermediate outcome (money moved, a refund is still owed) - NOT a completed cancellation or
 * refund. The callers must record a pending refund and must never treat the payment as
 * released, refunded or financially settled merely because the HTTP status was 200.
 *
 * Covers both events-service callers of the cancel route:
 *  - PUT /registrations/:id/reject (CRM rejection of a pending-review registration)
 *  - PUT /events/:id/cancel (releasePendingRegistrationPayment for never-approved registrations)
 */
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => require("./helpers/pdpMock.js").createPdpMock());
jest.mock("../services/accountService.client.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");
jest.mock("../rabbitMQ/publishers/event.lifecycle.publisher.js");

const { cancelPaymentIntent, voidManualRegistrationPayment } = require("../services/accountService.client.js");
const { publishEventCancelled } = require("../rabbitMQ/publishers/event.lifecycle.publisher.js");
const { isRefundRequiredResult } = require("../services/paymentCancelResult.js");

const app = require("../app");
const Event = require("../models/event.model.js");
const Registration = require("../models/registration.model.js");

const TENANT = "tenant-p5-refund-required";

const crm = () =>
  `Bearer ${jwt.sign({ sub: "crm-staff-1", tenantId: TENANT, userType: "CRM", roles: [] }, process.env.JWT_SECRET)}`;

let counter = 0;
function makeRegistration(eventId, overrides = {}) {
  counter += 1;
  const email = `p5-refund-${counter}@example.test`;
  return Registration.create({
    tenantId: TENANT,
    registrationType: "event",
    eventId,
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 5000,
    currency: "eur",
    paymentMethod: "stripe",
    paymentStatus: "authorized",
    stripePaymentIntentId: `pi_p5_refund_${counter}`,
    status: "pending",
    approvalStatus: "pending_review",
    registeredVia: "crm",
    isActive: true,
    ...overrides,
  });
}

function makeEvent(overrides = {}) {
  return Event.create({
    tenantId: TENANT,
    title: "P5 refund_required event",
    startDate: new Date(Date.now() + 7 * 86400000),
    endDate: new Date(Date.now() + 8 * 86400000),
    status: "Published",
    createdBy: "crm-staff-1",
    ...overrides,
  });
}

const REFUND_REQUIRED = { ok: true, canceled: false, status: "refund_required", stripeStatus: "succeeded", paymentId: "pay-captured-1" };
const CANCELED = { ok: true, canceled: true, status: "canceled", paymentId: "pay-held-1" };

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});
afterEach(async () => {
  await Event.deleteMany({ tenantId: TENANT });
  await Registration.deleteMany({ tenantId: TENANT });
  jest.clearAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe("isRefundRequiredResult", () => {
  it("is true only for the refund_required outcome", () => {
    expect(isRefundRequiredResult(REFUND_REQUIRED)).toBe(true);
    expect(isRefundRequiredResult(CANCELED)).toBe(false);
    expect(isRefundRequiredResult({ ok: true, alreadyCanceled: true, status: "canceled" })).toBe(false);
    expect(isRefundRequiredResult(null)).toBe(false);
    expect(isRefundRequiredResult(undefined)).toBe(false);
  });
});

describe("PUT /registrations/:id/reject", () => {
  it("refund_required: the rejection stands, the payment is recorded as captured with a PENDING refund - never released or refunded", async () => {
    const event = await makeEvent();
    const reg = await makeRegistration(event._id);
    cancelPaymentIntent.mockResolvedValue(REFUND_REQUIRED);

    const res = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", crm());

    expect(res.status).toBe(200);
    expect(res.body.refundRequired).toBe(true);
    const saved = await Registration.findById(reg._id).lean();
    expect(saved.approvalStatus).toBe("rejected");
    expect(saved.status).toBe("cancelled");
    expect(saved.paymentStatus).toBe("succeeded"); // money was captured - not "pending"/released
    expect(saved.refundRequired).toBe(true);
    expect(saved.refundRequiredAt).toBeInstanceOf(Date);
    // no settled / refunded state exists for it
    expect(["refunded", "failed", "pending", "authorized"]).not.toContain(saved.paymentStatus);
  });

  it("canceled: a released hold is NOT flagged as a refund", async () => {
    const event = await makeEvent();
    const reg = await makeRegistration(event._id);
    cancelPaymentIntent.mockResolvedValue(CANCELED);

    const res = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", crm());

    expect(res.status).toBe(200);
    expect(res.body.refundRequired).toBeUndefined();
    const saved = await Registration.findById(reg._id).lean();
    expect(saved.approvalStatus).toBe("rejected");
    expect(saved.refundRequired).toBe(false);
    expect(saved.paymentStatus).toBe("authorized"); // unchanged by the release
  });

  it("manual/comp/invoice void path is unchanged (no refund flag)", async () => {
    const event = await makeEvent();
    const reg = await makeRegistration(event._id, { paymentMethod: "manual", paymentStatus: "pending", stripePaymentIntentId: null, paymentId: "manual-pay-1" });
    voidManualRegistrationPayment.mockResolvedValue({ ok: true, voided: true });

    const res = await request(app).put(`/api/registrations/${reg._id}/reject`).set("Authorization", crm());

    expect(res.status).toBe(200);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect((await Registration.findById(reg._id).lean()).refundRequired).toBe(false);
  });
});

describe("PUT /events/:id/cancel (pending registrations)", () => {
  it("refund_required: the pending registration is recorded with a pending refund and surfaced; not treated as released", async () => {
    const event = await makeEvent();
    const captured = await makeRegistration(event._id);
    const held = await makeRegistration(event._id);
    cancelPaymentIntent.mockImplementation(async ({ paymentIntentId }) =>
      paymentIntentId === captured.stripePaymentIntentId ? REFUND_REQUIRED : CANCELED,
    );

    const res = await request(app).put(`/api/events/${event._id}/cancel`).set("Authorization", crm());

    expect(res.status).toBe(200);
    expect(res.body.refundRequiredRegistrationIds).toEqual([String(captured._id)]);
    const [c, h] = await Promise.all([Registration.findById(captured._id).lean(), Registration.findById(held._id).lean()]);
    expect(c.status).toBe("cancelled");
    expect(c.paymentStatus).toBe("succeeded");
    expect(c.refundRequired).toBe(true);
    expect(h.status).toBe("cancelled");
    expect(h.refundRequired).toBe(false);
    // not pushed into the automatic refund flow (account marks it refund_required, which that flow
    // skips, and a never-approved capture may have no GL posting to reverse)
    const [, refundCandidates] = publishEventCancelled.mock.calls[0];
    expect(refundCandidates.map((x) => String(x.registrationId))).not.toContain(String(captured._id));
  });

  it("all holds released: no refund flag and no refundRequiredRegistrationIds in the response", async () => {
    const event = await makeEvent();
    const reg = await makeRegistration(event._id);
    cancelPaymentIntent.mockResolvedValue(CANCELED);

    const res = await request(app).put(`/api/events/${event._id}/cancel`).set("Authorization", crm());

    expect(res.status).toBe(200);
    expect(res.body.refundRequiredRegistrationIds).toBeUndefined();
    expect((await Registration.findById(reg._id).lean()).refundRequired).toBe(false);
  });
});
