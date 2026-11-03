const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const app = require("../app");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Registration = require("../models/registration.model.js");
const { signCheckinToken } = require("../services/checkinToken.service.js");
const { completeEventById } = require("../controllers/event.controller.js");
const { TZ, sessionTiming } = require("./helpers/attendanceTiming.js");

const TENANT_ID = "tenant-attendance-test";

function authHeader() {
  const token = jwt.sign({ sub: "user-1", tenantId: TENANT_ID, userType: "CRM", roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

// A session happening now (inside every P5 window); virtual so the self route accepts it.
function liveSession(event, extra = {}) {
  return EventSession.create({ tenantId: TENANT_ID, eventId: event._id, label: "Day 1", date: event.startDate, isVirtual: true, ...sessionTiming(), ...extra });
}

function selfAuthHeader(userId) {
  const token = jwt.sign({ sub: userId, tenantId: TENANT_ID, userType: "PORTAL", roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

async function createEventDoc(overrides = {}) {
  return Event.create({
    tenantId: TENANT_ID,
    title: "Attendance Test Event",
    startDate: new Date("2020-01-01T09:00:00Z"),
    endDate: new Date("2020-01-01T17:00:00Z"),
    status: "Published",
    timezone: TZ,
    ...overrides,
  });
}

let attendeeCounter = 0;
async function createRegistrationDoc(eventId, overrides = {}) {
  attendeeCounter += 1;
  const email = `attendee${attendeeCounter}@example.com`;
  return Registration.create({
    tenantId: TENANT_ID,
    registrationType: "event",
    eventId,
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 0,
    currency: "eur",
    paymentMethod: "comp",
    paymentStatus: "waived",
    status: "confirmed",
    approvalStatus: "approved",
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
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("GET /registrations/:id/sessions/:sessionId/checkin-qr", () => {
  it("returns a signed token for a real registration+session", async () => {
    const event = await createEventDoc();
    const session = await liveSession(event);
    const registration = await createRegistrationDoc(event._id);

    const res = await request(app)
      .get(`/api/registrations/${registration._id}/sessions/${session._id}/checkin-qr`)
      .set("Authorization", authHeader());

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
  });
});

describe("organiser scan replaces the public redemption", () => {
  it("CRM scan marks attendance once and is idempotent on a repeat scan", async () => {
    const event = await createEventDoc();
    const session = await liveSession(event);
    const registration = await createRegistrationDoc(event._id);
    const token = signCheckinToken({
      tenantId: TENANT_ID,
      registrationId: String(registration._id),
      sessionId: String(session._id),
      expiresAt: Date.now() + 3600000,
    });

    const first = await request(app).post("/api/registrations/checkin/scan").set("Authorization", authHeader()).send({ token });
    expect(first.status).toBe(200);
    expect(first.body.data.alreadyCheckedIn).toBe(false);

    const second = await request(app).post("/api/registrations/checkin/scan").set("Authorization", authHeader()).send({ token });
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyCheckedIn).toBe(true);

    const reloaded = await Registration.findById(registration._id);
    expect(reloaded.sessionAttendance).toHaveLength(1);
    expect(reloaded.sessionAttendance[0].status).toBe("attended");
    expect(reloaded.sessionAttendance[0].method).toBe("qr-organizer");
  });

  it("the public link never writes (410) and an invalid pass is a 400 at the scan", async () => {
    const res = await request(app).post("/api/public/checkin/garbage-token");
    expect(res.status).toBe(410);
    const scan = await request(app).post("/api/registrations/checkin/scan").set("Authorization", authHeader()).send({ token: "garbage" });
    expect(scan.status).toBe(400);
    expect(scan.body.error.code).toBe("CHECKIN_PASS_INVALID");
  });
});

describe("PUT /registrations/:id/sessions/:sessionId/attendance (CRM)", () => {
  it("sets attendance, and can overwrite a previous QR-set entry", async () => {
    const event = await createEventDoc();
    const session = await EventSession.create({ tenantId: TENANT_ID, eventId: event._id, label: "Day 1", date: event.startDate });
    const registration = await createRegistrationDoc(event._id, {
      sessionAttendance: [{ sessionId: session._id, status: "attended", method: "qr", markedAt: new Date() }],
    });

    // Overwriting an existing entry needs a reason; the overwritten value is kept.
    const noReason = await request(app)
      .put(`/api/registrations/${registration._id}/sessions/${session._id}/attendance`)
      .set("Authorization", authHeader())
      .send({ status: "absent" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("CORRECTION_REASON_REQUIRED");

    const res = await request(app)
      .put(`/api/registrations/${registration._id}/sessions/${session._id}/attendance`)
      .set("Authorization", authHeader())
      .send({ status: "absent", reason: "Left before the session started" });

    expect(res.status).toBe(200);
    const reloaded = await Registration.findById(registration._id);
    expect(reloaded.sessionAttendance).toHaveLength(1);
    expect(reloaded.sessionAttendance[0].status).toBe("absent");
    expect(reloaded.sessionAttendance[0].method).toBe("manual-crm");
    expect(reloaded.sessionAttendance[0].previous).toMatchObject({ status: "attended", method: "qr" });
  });

  it("400s on an invalid status value", async () => {
    const event = await createEventDoc();
    const session = await EventSession.create({ tenantId: TENANT_ID, eventId: event._id, label: "Day 1", date: event.startDate });
    const registration = await createRegistrationDoc(event._id);

    const res = await request(app)
      .put(`/api/registrations/${registration._id}/sessions/${session._id}/attendance`)
      .set("Authorization", authHeader())
      .send({ status: "maybe" });
    expect(res.status).toBe(400);
  });
});

describe("POST /registrations/:id/sessions/:sessionId/attendance/self", () => {
  it("lets the submitting attendee mark their own attendance", async () => {
    const event = await createEventDoc();
    const session = await liveSession(event);
    const registration = await createRegistrationDoc(event._id, { submittedByUserId: "user-attendee-1" });

    const res = await request(app)
      .post(`/api/registrations/${registration._id}/sessions/${session._id}/attendance/self`)
      .set("Authorization", selfAuthHeader("user-attendee-1"));

    expect(res.status).toBe(200);
    const reloaded = await Registration.findById(registration._id);
    expect(reloaded.sessionAttendance[0]).toMatchObject({ status: "attended", method: "manual-attendee" });
  });

  it("403 NOT_OWNER for a registration the caller didn't submit", async () => {
    const event = await createEventDoc();
    const session = await EventSession.create({ tenantId: TENANT_ID, eventId: event._id, label: "Day 1", date: event.startDate });
    const registration = await createRegistrationDoc(event._id, { submittedByUserId: "user-attendee-1" });

    const res = await request(app)
      .post(`/api/registrations/${registration._id}/sessions/${session._id}/attendance/self`)
      .set("Authorization", selfAuthHeader("someone-else"));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    const reloaded = await Registration.findById(registration._id);
    expect(reloaded.sessionAttendance).toHaveLength(0);
  });
});

describe("completeEventById - attendance rollup on completion", () => {
  it("marks a fully-attended confirmed registration 'attended' and a partially-attended one 'no-show'", async () => {
    const event = await createEventDoc();
    const session = await EventSession.create({ tenantId: TENANT_ID, eventId: event._id, label: "Day 1", date: event.startDate });

    const attendedReg = await createRegistrationDoc(event._id, {
      sessionAttendance: [{ sessionId: session._id, status: "attended", method: "manual-crm", markedAt: new Date() }],
    });
    const noShowReg = await createRegistrationDoc(event._id, { sessionAttendance: [] });

    await completeEventById({ event, tenantId: TENANT_ID, actorId: "user-1", actorEmail: null });

    const [reloadedAttended, reloadedNoShow] = await Promise.all([
      Registration.findById(attendedReg._id),
      Registration.findById(noShowReg._id),
    ]);
    expect(reloadedAttended.status).toBe("attended");
    expect(reloadedNoShow.status).toBe("no-show");
  });
});
