/**
 * P5 B3 - attendance structure: POST .../attendance/self, GET .../checkin-qr,
 * POST /public/checkin/:token and PUT .../attendance (CRM) validate the
 * session against the registration's own event in the verified tenant, the
 * registration's eligibility, and partial-attendance session selection. The
 * self route is PORTAL-only. No time window is enforced (product decision
 * pending) - see .claude/rules/attendance.md.
 *
 * PDP mocked (tests/helpers/pdpMock.js); AUTH_BYPASS_ENABLED off so the
 * caller class and PDP path are the real ones.
 */
process.env.AUTH_BYPASS_ENABLED = "false";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => require("./helpers/pdpMock.js").createPdpMock());

const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const app = require("../app");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Course = require("../models/course.model.js");
const Registration = require("../models/registration.model.js");
const { signCheckinToken } = require("../services/checkinToken.service.js");

const TENANT = "tenant-p5b3-attendance-a";
const OTHER_TENANT = "tenant-p5b3-attendance-b";
const USER_A = "p5b3-portal-a";
const USER_B = "p5b3-portal-b";
const CRM_USER = "p5b3-crm-1";

function bearer({ sub, tenantId = TENANT, userType }) {
  const claims = { sub, tenantId, roles: [] };
  if (userType !== undefined) claims.userType = userType;
  return `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}`;
}
const portalA = () => bearer({ sub: USER_A, userType: "PORTAL" });
const portalB = () => bearer({ sub: USER_B, userType: "PORTAL" });
const crm = () => bearer({ sub: CRM_USER, userType: "CRM" });

let counter = 0;
function makeRegistration(overrides = {}) {
  counter += 1;
  const email = `p5b3-${counter}@example.test`;
  return Registration.create({
    tenantId: TENANT,
    registrationType: "event",
    eventId: eventA._id,
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 0,
    currency: "eur",
    paymentMethod: "comp",
    paymentStatus: "waived",
    status: "confirmed",
    approvalStatus: "approved",
    registeredVia: "portal",
    isActive: true,
    submittedByUserId: USER_A,
    ...overrides,
  });
}

const eventBase = {
  title: "P5B3 event",
  startDate: new Date("2030-01-01T09:00:00Z"),
  endDate: new Date("2030-01-02T17:00:00Z"),
  status: "Published",
};

let eventA;
let eventOther;
let eventTenantB;
let sessionA1;
let sessionA2;
let sessionOtherEvent;
let sessionTenantB;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

beforeEach(async () => {
  eventA = await Event.create({ tenantId: TENANT, ...eventBase });
  eventOther = await Event.create({ tenantId: TENANT, ...eventBase, title: "Other event" });
  eventTenantB = await Event.create({ tenantId: OTHER_TENANT, ...eventBase });
  sessionA1 = await EventSession.create({ tenantId: TENANT, eventId: eventA._id, label: "Day 1", date: eventA.startDate });
  sessionA2 = await EventSession.create({ tenantId: TENANT, eventId: eventA._id, label: "Day 2", date: eventA.endDate });
  sessionOtherEvent = await EventSession.create({ tenantId: TENANT, eventId: eventOther._id, label: "Day 1", date: eventA.startDate });
  sessionTenantB = await EventSession.create({ tenantId: OTHER_TENANT, eventId: eventTenantB._id, label: "Day 1", date: eventA.startDate });
  defaultPolicyMiddleware.calls.length = 0;
});

afterEach(async () => {
  for (const Model of [Event, EventSession, Course, Registration]) {
    await Model.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } });
  }
});

afterAll(async () => {
  await mongoose.disconnect();
});

const selfPath = (regId, sessionId) => `/api/registrations/${regId}/sessions/${sessionId}/attendance/self`;
const qrPath = (regId, sessionId) => `/api/registrations/${regId}/sessions/${sessionId}/checkin-qr`;
const crmPath = (regId, sessionId) => `/api/registrations/${regId}/sessions/${sessionId}/attendance`;

async function attendanceOf(reg) {
  const fresh = await Registration.findById(reg._id).lean();
  return fresh.sessionAttendance;
}

describe("POST .../attendance/self (PORTAL attendee)", () => {
  it("T1 own confirmed/approved registration + session of the same event -> 200, one manual-attendee entry", async () => {
    const reg = await makeRegistration();
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(200);
    const entries = await attendanceOf(reg);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "attended", method: "manual-attendee" });
    expect(String(entries[0].sessionId)).toBe(String(sessionA1._id));
  });

  it("T2 repeat -> 200 no-op, still one entry", async () => {
    const reg = await makeRegistration();
    await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(200);
    expect(await attendanceOf(reg)).toHaveLength(1);
  });

  it("T3 another member's registration id -> 403 NOT_OWNER, no write", async () => {
    const regB = await makeRegistration({ submittedByUserId: USER_B });
    const res = await request(app).post(selfPath(regB._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    expect(await attendanceOf(regB)).toHaveLength(0);
  });

  it("T4 member B's token on member A's registration -> 403 NOT_OWNER, no write", async () => {
    const reg = await makeRegistration();
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalB());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T5 own registration + session of a different event in the same tenant -> 404, no write", async () => {
    const reg = await makeRegistration();
    const res = await request(app).post(selfPath(reg._id, sessionOtherEvent._id)).set("Authorization", portalA());
    expect(res.status).toBe(404);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T6 own registration + nonexistent / deleted session -> 404, no write", async () => {
    const reg = await makeRegistration();
    const missing = await request(app)
      .post(selfPath(reg._id, new mongoose.Types.ObjectId()))
      .set("Authorization", portalA());
    expect(missing.status).toBe(404);
    await EventSession.updateOne({ _id: sessionA2._id }, { $set: { isDeleted: true } });
    const deleted = await request(app).post(selfPath(reg._id, sessionA2._id)).set("Authorization", portalA());
    expect(deleted.status).toBe(404);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T7 partial attendance: session not in registration.sessionIds -> 403 SESSION_NOT_SELECTED; selected session -> 200", async () => {
    await Event.updateOne({ _id: eventA._id }, { $set: { allowPartialAttendance: true } });
    const reg = await makeRegistration({ sessionIds: [sessionA1._id] });
    const notSelected = await request(app).post(selfPath(reg._id, sessionA2._id)).set("Authorization", portalA());
    expect(notSelected.status).toBe(403);
    expect(notSelected.body.error.code).toBe("SESSION_NOT_SELECTED");
    expect(await attendanceOf(reg)).toHaveLength(0);

    const selected = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(selected.status).toBe(200);
    expect(await attendanceOf(reg)).toHaveLength(1);
  });

  it("T7b no partial attendance on the event: any session of the event is the attendee's", async () => {
    const reg = await makeRegistration({ sessionIds: [sessionA1._id] });
    const res = await request(app).post(selfPath(reg._id, sessionA2._id)).set("Authorization", portalA());
    expect(res.status).toBe(200);
  });

  it("T8 malformed sessionId / registration id -> 400 (never a 500 cast error), no write", async () => {
    const reg = await makeRegistration();
    const badSession = await request(app).post(selfPath(reg._id, "not-an-id")).set("Authorization", portalA());
    expect(badSession.status).toBe(400);
    expect(badSession.body.error.code).toBe("INVALID_SESSION_ID");
    const badReg = await request(app).post(selfPath("not-an-id", sessionA1._id)).set("Authorization", portalA());
    expect(badReg.status).toBe(400);
    expect(badReg.body.error.code).toBe("INVALID_REGISTRATION_ID");
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T9 other tenant: registration in tenant B -> 403 NOT_OWNER; session in tenant B -> 404; no write", async () => {
    const regTenantB = await makeRegistration({ tenantId: OTHER_TENANT, eventId: eventTenantB._id });
    const otherTenantReg = await request(app)
      .post(selfPath(regTenantB._id, sessionTenantB._id))
      .set("Authorization", portalA());
    expect(otherTenantReg.status).toBe(403);
    expect(otherTenantReg.body.code).toBe("NOT_OWNER");
    expect(await attendanceOf(regTenantB)).toHaveLength(0);

    const reg = await makeRegistration();
    const otherTenantSession = await request(app)
      .post(selfPath(reg._id, sessionTenantB._id))
      .set("Authorization", portalA());
    expect(otherTenantSession.status).toBe(404);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it.each([
    ["cancelled (isActive false)", { status: "cancelled", isActive: false }],
    ["rejected", { status: "cancelled", approvalStatus: "rejected", isActive: false }],
    ["pending_review", { status: "pending", approvalStatus: "pending_review" }],
    ["status pending (approved)", { status: "pending", approvalStatus: "approved" }],
    ["processing approval", { status: "pending", approvalStatus: "processing" }],
    ["already rolled up (attended)", { status: "attended" }],
    ["already rolled up (no-show)", { status: "no-show" }],
  ])("T10 own registration %s -> 409 REGISTRATION_NOT_ELIGIBLE, no write", async (_label, overrides) => {
    const reg = await makeRegistration(overrides);
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REGISTRATION_NOT_ELIGIBLE");
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T12 CRM caller on a registration it submitted -> 403 PORTAL_ONLY, PDP never consulted, no write", async () => {
    const reg = await makeRegistration({ submittedByUserId: CRM_USER, registeredVia: "crm" });
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", crm());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PORTAL_ONLY");
    expect(defaultPolicyMiddleware.calls).toEqual([]);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T12b unknown / missing userType -> 403 FORBIDDEN_CALLER", async () => {
    const reg = await makeRegistration();
    for (const auth of [bearer({ sub: USER_A }), bearer({ sub: USER_A, userType: "SERVICE" })]) {
      const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", auth);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN_CALLER");
    }
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("T13 existing CRM 'absent' entry -> self cannot flip it (200 no-op, still absent/manual-crm)", async () => {
    const reg = await makeRegistration({
      sessionAttendance: [{ sessionId: sessionA1._id, status: "absent", method: "manual-crm", markedBy: CRM_USER }],
    });
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(200);
    const entries = await attendanceOf(reg);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "absent", method: "manual-crm" });
  });

  it("T14 course registration -> 409 ATTENDANCE_NOT_SUPPORTED (courses have no sessions), no write", async () => {
    const course = await Course.create({ tenantId: TENANT, title: "P5B3 course", startDate: new Date("2030-02-01") });
    const reg = await makeRegistration({ registrationType: "course", eventId: null, courseId: course._id });
    const res = await request(app).post(selfPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ATTENDANCE_NOT_SUPPORTED");
    expect(await attendanceOf(reg)).toHaveLength(0);
  });
});

describe("GET .../checkin-qr (QR minting)", () => {
  it("own eligible registration + session of the same event -> 200 token", async () => {
    const reg = await makeRegistration();
    const res = await request(app).get(qrPath(reg._id, sessionA1._id)).set("Authorization", portalA());
    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe("string");
  });

  it("T15 session of another event -> 404, no token (PORTAL and CRM)", async () => {
    const reg = await makeRegistration();
    for (const auth of [portalA(), crm()]) {
      const res = await request(app).get(qrPath(reg._id, sessionOtherEvent._id)).set("Authorization", auth);
      expect(res.status).toBe(404);
      expect(res.body.data?.token).toBeUndefined();
    }
  });

  it("ineligible registration (pending_review / cancelled) -> 409, no token", async () => {
    for (const overrides of [
      { status: "pending", approvalStatus: "pending_review" },
      { status: "cancelled", isActive: false },
    ]) {
      const reg = await makeRegistration(overrides);
      const res = await request(app).get(qrPath(reg._id, sessionA1._id)).set("Authorization", portalA());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("REGISTRATION_NOT_ELIGIBLE");
    }
  });

  it("partial attendance: unselected session -> 403 SESSION_NOT_SELECTED", async () => {
    await Event.updateOne({ _id: eventA._id }, { $set: { allowPartialAttendance: true } });
    const reg = await makeRegistration({ sessionIds: [sessionA1._id] });
    const res = await request(app).get(qrPath(reg._id, sessionA2._id)).set("Authorization", portalA());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SESSION_NOT_SELECTED");
  });

  it("malformed session id -> 400", async () => {
    const reg = await makeRegistration();
    const res = await request(app).get(qrPath(reg._id, "bogus")).set("Authorization", portalA());
    expect(res.status).toBe(400);
  });
});

describe("POST /public/checkin/:token (QR redemption)", () => {
  const tokenFor = (reg, session, tenantId = TENANT) =>
    signCheckinToken({ tenantId, registrationId: String(reg._id), sessionId: String(session._id) });

  it("valid token -> 200, one qr entry", async () => {
    const reg = await makeRegistration();
    const res = await request(app).post(`/api/public/checkin/${tokenFor(reg, sessionA1)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyCheckedIn).toBe(false);
    expect(await attendanceOf(reg)).toHaveLength(1);
  });

  it("token pairing a session of another event -> 404, no write", async () => {
    const reg = await makeRegistration();
    const res = await request(app).post(`/api/public/checkin/${tokenFor(reg, sessionOtherEvent)}`);
    expect(res.status).toBe(404);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("token for a registration since cancelled / still pending -> 409, no write", async () => {
    for (const overrides of [
      { status: "cancelled", isActive: false },
      { status: "pending", approvalStatus: "pending_review" },
    ]) {
      const reg = await makeRegistration(overrides);
      const res = await request(app).post(`/api/public/checkin/${tokenFor(reg, sessionA1)}`);
      expect(res.status).toBe(409);
      expect(await attendanceOf(reg)).toHaveLength(0);
    }
  });

  it("token for an unselected session on a partial-attendance event -> 403, no write", async () => {
    await Event.updateOne({ _id: eventA._id }, { $set: { allowPartialAttendance: true } });
    const reg = await makeRegistration({ sessionIds: [sessionA1._id] });
    const res = await request(app).post(`/api/public/checkin/${tokenFor(reg, sessionA2)}`);
    expect(res.status).toBe(403);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });
});

describe("PUT .../attendance (CRM)", () => {
  it("session of the registration's own event -> 200 manual-crm with markedBy", async () => {
    const reg = await makeRegistration();
    const res = await request(app).put(crmPath(reg._id, sessionA1._id)).set("Authorization", crm()).send({ status: "attended" });
    expect(res.status).toBe(200);
    const entries = await attendanceOf(reg);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "attended", method: "manual-crm", markedBy: CRM_USER });
  });

  it("session of another event (same tenant) -> 404, no write", async () => {
    const reg = await makeRegistration();
    const res = await request(app)
      .put(crmPath(reg._id, sessionOtherEvent._id))
      .set("Authorization", crm())
      .send({ status: "attended" });
    expect(res.status).toBe(404);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("session of another tenant -> 404, no write", async () => {
    const reg = await makeRegistration();
    const res = await request(app)
      .put(crmPath(reg._id, sessionTenantB._id))
      .set("Authorization", crm())
      .send({ status: "absent" });
    expect(res.status).toBe(404);
    expect(await attendanceOf(reg)).toHaveLength(0);
  });

  it("malformed session id -> 400, never a 500", async () => {
    const reg = await makeRegistration();
    const res = await request(app).put(crmPath(reg._id, "bogus")).set("Authorization", crm()).send({ status: "attended" });
    expect(res.status).toBe(400);
  });

  it("staff correction still allowed after the rollup (status no-show)", async () => {
    const reg = await makeRegistration({ status: "no-show" });
    const res = await request(app).put(crmPath(reg._id, sessionA1._id)).set("Authorization", crm()).send({ status: "attended" });
    expect(res.status).toBe(200);
  });
});
