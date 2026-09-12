const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../services/accountService.client.js");
jest.mock("../services/profileLookup.client.js");

const { capturePaymentIntent } = require("../services/accountService.client.js");
const {
  getProfileMembershipNumber,
  updateAttendeeProfileFields,
} = require("../services/profileLookup.client.js");

const app = require("../app");
const Registration = require("../models/registration.model.js");

const TENANT_ID = "tenant-approval-capture-test";

function authHeader() {
  const token = jwt.sign({ sub: "user-1", tenantId: TENANT_ID, roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

// Shape of the raw axios error account-service's capture 409 produces (see
// payments.service.js's capturePaymentIntent guard and response.mw.js's
// res.appError, which serializes the whole AppError instance under
// `details`) - capturePaymentIntent in accountService.client.js is an
// unwrapped axios call, so this is exactly what
// registrationApproval.service.js's catch receives.
function stripeCaptureConflict(stripeStatus, paymentIntentId) {
  const err = new Error("Request failed with status code 409");
  err.isAxiosError = true;
  err.response = {
    status: 409,
    data: {
      status: "fail",
      message: `PaymentIntent cannot be captured from status ${stripeStatus}`,
      code: "CONFLICT",
      details: { name: "AppError", status: 409, code: "CONFLICT", stripeStatus, paymentIntentId },
    },
  };
  return err;
}

async function createAuthorizedRegistration(overrides = {}) {
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
    stripePaymentIntentId: "pi_expired_auth",
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

describe("PUT /registrations/:id/approve - capture of an expired/canceled authorization", () => {
  it("corrects the stale 'authorized' paymentStatus to 'failed' and releases the approval claim", async () => {
    const registration = await createAuthorizedRegistration();
    getProfileMembershipNumber.mockResolvedValue(null);
    capturePaymentIntent.mockRejectedValue(stripeCaptureConflict("canceled", "pi_expired_auth"));

    const res = await request(app)
      .put(`/api/registrations/${registration._id}/approve`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(409);
    // The bare Stripe status message is rewritten to something the CRM user
    // can act on (see registrationApproval.service.js's catch).
    expect(res.body.error.message).toMatch(/Retry Payment/);

    const updated = await Registration.findById(registration._id);
    expect(updated.paymentStatus).toBe("failed");
    expect(updated.approvalStatus).toBe("pending_review");
  });

  it("leaves paymentStatus alone when the capture conflict is not stripe-status-shaped", async () => {
    const registration = await createAuthorizedRegistration({ stripePaymentIntentId: null });

    const res = await request(app)
      .put(`/api/registrations/${registration._id}/approve`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(409);
    expect(capturePaymentIntent).not.toHaveBeenCalled();

    const updated = await Registration.findById(registration._id);
    expect(updated.paymentStatus).toBe("authorized");
    expect(updated.approvalStatus).toBe("pending_review");
  });
});

describe("PUT /registrations/:id/approve - syncing contact details onto an already-linked Profile", () => {
  it("overwrites the matched Profile's contact details with this registration's attendeeSnapshot", async () => {
    const registration = await createAuthorizedRegistration({
      duplicateReview: { status: "EXACT_MATCH", matchedProfileId: "profile-1" },
      attendeeSnapshot: {
        email: "attendee@example.com",
        normalizedEmail: "attendee@example.com",
        phone: "+353871234567",
        addressLine1: "New Address Line 1",
        townCity: "Cork",
      },
    });
    getProfileMembershipNumber.mockResolvedValue("M-123");
    updateAttendeeProfileFields.mockResolvedValue({ updated: true, profileId: "profile-1" });
    capturePaymentIntent.mockResolvedValue({ status: "succeeded" });

    const res = await request(app)
      .put(`/api/registrations/${registration._id}/approve`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(updateAttendeeProfileFields).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        profileId: "profile-1",
        email: "attendee@example.com",
        phone: "+353871234567",
        addressLine1: "New Address Line 1",
        townCity: "Cork",
      }),
    );

    const updated = await Registration.findById(registration._id);
    expect(updated.approvalStatus).toBe("approved");
    expect(updated.profileId).toBe("profile-1");
  });

  it("does not fail approval when the Profile contact-details sync rejects", async () => {
    const registration = await createAuthorizedRegistration();
    getProfileMembershipNumber.mockResolvedValue("M-123");
    updateAttendeeProfileFields.mockRejectedValue(
      Object.assign(new Error("Another profile already uses this email address"), {
        code: "ATTENDEE_EMAIL_CONFLICT",
      }),
    );
    capturePaymentIntent.mockResolvedValue({ status: "succeeded" });

    const res = await request(app)
      .put(`/api/registrations/${registration._id}/approve`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    const updated = await Registration.findById(registration._id);
    expect(updated.approvalStatus).toBe("approved");
  });
});
