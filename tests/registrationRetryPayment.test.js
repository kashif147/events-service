const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../services/accountService.client.js");
const { createRegistrationPaymentIntent } = require("../services/accountService.client.js");

const app = require("../app");
const Registration = require("../models/registration.model.js");

const TENANT_ID = "tenant-retry-payment-test";

function authHeader() {
  const token = jwt.sign({ sub: "user-1", tenantId: TENANT_ID, roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

async function createStuckStripeRegistration(overrides = {}) {
  return Registration.create({
    tenantId: TENANT_ID,
    registrationType: "event",
    eventId: new mongoose.Types.ObjectId(),
    approvalStatus: "pending_review",
    attendeeSnapshot: { email: "attendee@example.com", normalizedEmail: "attendee@example.com" },
    amount: 5000,
    currency: "eur",
    paymentMethod: "stripe",
    paymentStatus: "pending",
    status: "pending",
    stripePaymentIntentId: "pi_stuck_requires_payment_method",
    registeredVia: "crm",
    ...overrides,
  });
}

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

describe("POST /registrations/:id/retry-payment", () => {
  it("reuses the same PaymentIntent's clientSecret and stays pending when Stripe still needs a payment method", async () => {
    const registration = await createStuckStripeRegistration();
    createRegistrationPaymentIntent.mockResolvedValue({
      paymentId: "payment-1",
      paymentIntentId: "pi_stuck_requires_payment_method",
      clientSecret: "pi_stuck_requires_payment_method_secret_reused",
      status: "requires_action",
    });

    const res = await request(app)
      .post(`/api/registrations/${registration._id}/retry-payment`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.clientSecret).toBe("pi_stuck_requires_payment_method_secret_reused");
    expect(res.body.data.paymentIntentId).toBe("pi_stuck_requires_payment_method");
    expect(res.body.data.paymentStatus).toBe("pending");

    const updated = await Registration.findById(registration._id);
    expect(updated.paymentStatus).toBe("pending");
    expect(updated.stripePaymentIntentId).toBe("pi_stuck_requires_payment_method");
  });

  it("marks the registration authorized and swaps in the superseded PaymentIntent id when account-service issues a fresh one", async () => {
    const registration = await createStuckStripeRegistration();
    createRegistrationPaymentIntent.mockResolvedValue({
      paymentId: "payment-2",
      paymentIntentId: "pi_fresh_replacement",
      clientSecret: "pi_fresh_replacement_secret",
      status: "requires_capture",
    });

    const res = await request(app)
      .post(`/api/registrations/${registration._id}/retry-payment`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.paymentIntentId).toBe("pi_fresh_replacement");
    expect(res.body.data.paymentStatus).toBe("authorized");

    const updated = await Registration.findById(registration._id);
    expect(updated.stripePaymentIntentId).toBe("pi_fresh_replacement");
    expect(updated.paymentStatus).toBe("authorized");
  });

  it("rejects retry for a registration that is not pending_review", async () => {
    const registration = await createStuckStripeRegistration({ approvalStatus: "approved" });

    const res = await request(app)
      .post(`/api/registrations/${registration._id}/retry-payment`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(400);
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });

  it("rejects retry for a non-stripe registration", async () => {
    const registration = await createStuckStripeRegistration({
      paymentMethod: "manual",
      stripePaymentIntentId: null,
    });

    const res = await request(app)
      .post(`/api/registrations/${registration._id}/retry-payment`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(400);
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });
});
