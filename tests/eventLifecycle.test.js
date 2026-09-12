const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../services/accountService.client.js");
const { cancelPaymentIntent, voidManualRegistrationPayment } = require("../services/accountService.client.js");

const app = require("../app");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Registration = require("../models/registration.model.js");

const TENANT_ID = "tenant-event-lifecycle-test";

function authHeader() {
  const token = jwt.sign({ sub: "user-1", tenantId: TENANT_ID, roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

async function createEventDoc(overrides = {}) {
  return Event.create({
    tenantId: TENANT_ID,
    title: "Test Event",
    startDate: new Date("2020-01-01T09:00:00Z"),
    endDate: new Date("2020-01-01T17:00:00Z"),
    status: "Draft",
    createdBy: "user-1",
    ...overrides,
  });
}

let attendeeCounter = 0;

// Each registration for the same event needs a distinct
// attendeeSnapshot.normalizedEmail - the unique partial index on
// {tenantId, eventId, attendeeSnapshot.normalizedEmail, isActive:true} (see
// registration.model.js) would otherwise reject the second/third active
// registration for the same event with a duplicate-key error.
async function createRegistrationDoc(eventId, overrides = {}) {
  attendeeCounter += 1;
  const email = `attendee${attendeeCounter}@example.com`;
  return Registration.create({
    tenantId: TENANT_ID,
    registrationType: "event",
    eventId,
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 5000,
    currency: "eur",
    paymentMethod: "stripe",
    paymentStatus: "pending",
    status: "pending",
    registeredVia: "crm",
    isActive: true,
    ...overrides,
  });
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(async () => {
  await Event.deleteMany({ tenantId: TENANT_ID });
  await EventSession.deleteMany({ tenantId: TENANT_ID });
  await Registration.deleteMany({ tenantId: TENANT_ID });
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("PUT /events/:id/unpublish", () => {
  it("400s when the event is not Published", async () => {
    const event = await createEventDoc({ status: "Draft" });
    const res = await request(app)
      .put(`/api/events/${event._id}/unpublish`)
      .set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });

  it("moves a Published event back to Draft without touching registrations", async () => {
    const event = await createEventDoc({ status: "Published" });
    const registration = await createRegistrationDoc(event._id, { status: "confirmed", approvalStatus: "approved" });

    const res = await request(app)
      .put(`/api/events/${event._id}/unpublish`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("Draft");

    const stillActive = await Registration.findById(registration._id);
    expect(stillActive.status).toBe("confirmed");
    expect(stillActive.isActive).toBe(true);
  });
});

describe("PUT /events/:id/cancel", () => {
  it("400s when the event is not Published", async () => {
    const event = await createEventDoc({ status: "Draft" });
    const res = await request(app).put(`/api/events/${event._id}/cancel`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });

  it("bulk-cancels active registrations, releases an unapproved payment hold, and flags the confirmed/paid one as a refund candidate", async () => {
    const event = await createEventDoc({ status: "Published" });

    const pendingReg = await createRegistrationDoc(event._id, {
      status: "pending",
      approvalStatus: "pending_review",
      paymentMethod: "stripe",
      paymentStatus: "authorized",
      stripePaymentIntentId: "pi_pending_hold",
    });
    const confirmedPaidReg = await createRegistrationDoc(event._id, {
      status: "confirmed",
      approvalStatus: "approved",
      paymentMethod: "stripe",
      paymentStatus: "succeeded",
      paymentId: "payment-doc-id-1",
      stripePaymentIntentId: "pi_confirmed_paid",
    });
    const compReg = await createRegistrationDoc(event._id, {
      status: "confirmed",
      approvalStatus: "approved",
      paymentMethod: "comp",
      paymentStatus: "waived",
      amount: 0,
    });

    cancelPaymentIntent.mockResolvedValue({});

    const res = await request(app).put(`/api/events/${event._id}/cancel`).set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("Cancelled");

    const [reloadedPending, reloadedConfirmed, reloadedComp] = await Promise.all([
      Registration.findById(pendingReg._id),
      Registration.findById(confirmedPaidReg._id),
      Registration.findById(compReg._id),
    ]);
    expect(reloadedPending.status).toBe("cancelled");
    expect(reloadedPending.isActive).toBe(false);
    expect(reloadedConfirmed.status).toBe("cancelled");
    expect(reloadedComp.status).toBe("cancelled");

    // Pending (never approved) registration's authorization hold is released,
    // not refunded - nothing was ever captured for it.
    expect(cancelPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_pending_hold" }),
    );
    expect(voidManualRegistrationPayment).not.toHaveBeenCalled();
  });

  it("does not error when the event has no active registrations", async () => {
    const event = await createEventDoc({ status: "Published" });
    const res = await request(app).put(`/api/events/${event._id}/cancel`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("Cancelled");
  });
});

describe("PUT /events/:id/complete", () => {
  it("400s when the event is not Published", async () => {
    const event = await createEventDoc({ status: "Draft", endDate: new Date("2020-01-01T00:00:00Z") });
    const res = await request(app).put(`/api/events/${event._id}/complete`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });

  it("400s when the event's last day/date has not passed yet", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const event = await createEventDoc({ status: "Published", startDate: future, endDate: future });
    const res = await request(app).put(`/api/events/${event._id}/complete`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });

  it("completes once the event's last day/date has passed", async () => {
    const past = new Date("2020-01-01T00:00:00Z");
    const event = await createEventDoc({ status: "Published", startDate: past, endDate: past });
    const res = await request(app).put(`/api/events/${event._id}/complete`).set("Authorization", authHeader());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("Completed");
  });

  it("uses the latest EventSession date, not just Event.endDate, for multi-day events", async () => {
    const past = new Date("2020-01-01T00:00:00Z");
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    // Event.endDate looks past-due, but a later session means the course
    // isn't actually over yet.
    const event = await createEventDoc({ status: "Published", startDate: past, endDate: past });
    await EventSession.create({ tenantId: TENANT_ID, eventId: event._id, label: "Day 2", date: future });

    const res = await request(app).put(`/api/events/${event._id}/complete`).set("Authorization", authHeader());
    expect(res.status).toBe(400);
  });
});

describe("PUT /events/:id (generic) - Published events can no longer change status here", () => {
  it("rejects a status key entirely once Published, even a value it already has", async () => {
    const event = await createEventDoc({ status: "Published" });
    const res = await request(app)
      .put(`/api/events/${event._id}`)
      .set("Authorization", authHeader())
      .send({ status: "Published" });
    expect(res.status).toBe(400);
  });

  it("still allows isActive/description changes on a Published event", async () => {
    const event = await createEventDoc({ status: "Published" });
    const res = await request(app)
      .put(`/api/events/${event._id}`)
      .set("Authorization", authHeader())
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.status).toBe("Published");
  });
});
