/**
 * P5 attendance window (owner-approved 2026-11-03):
 *   opens start-30 min; organiser QR scan closes end+60 min; virtual self closes end+15 min;
 *   self unavailable for in-person; explicit IANA event timezone, no fallback; missing/invalid
 *   timezone or incomplete timing fails closed; DST gaps rejected, overlaps need an explicit
 *   offset; overnight via explicit endLocalDate; organiser scan replaces public redemption;
 *   CRM corrections need a reason outside the window / on overwrite, keep the previous value,
 *   flag issued certificates on downgrade, and are audited through the transactional outbox.
 *
 * Real app + real Mongo (single-node replica set: transactions). PDP mocked
 * (tests/helpers/pdpMock.js).
 */
process.env.AUTH_BYPASS_ENABLED = "false";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => require("./helpers/pdpMock.js").createPdpMock());

const app = require("../app");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const Registration = require("../models/registration.model.js");
const Certificate = require("../models/certificate.model.js");
const OutboxEvent = require("../models/outboxEvent.model.js");
const { signCheckinToken, verifyCheckinToken } = require("../services/checkinToken.service.js");
const win = require("../services/attendanceWindow.service.js");
const outbox = require("../services/outbox.service.js");
const { sessionTiming } = require("./helpers/attendanceTiming.js");

const TENANT = "aaaaaaaaaaaaaaaaaaaaaa01";
const OTHER_TENANT = "bbbbbbbbbbbbbbbbbbbbbb02";
const OWNER = "p5win-portal-owner";
const CRM_USER = "p5win-crm-1";
const MIN = 60000;

function bearer({ sub, tenantId = TENANT, userType }) {
  return `Bearer ${jwt.sign({ sub, tenantId, roles: [], userType }, process.env.JWT_SECRET)}`;
}
const portal = () => bearer({ sub: OWNER, userType: "PORTAL" });
const crm = (tenantId = TENANT) => bearer({ sub: CRM_USER, tenantId, userType: "CRM" });

let counter = 0;
async function makeEvent(overrides = {}) {
  return Event.create({
    tenantId: TENANT,
    title: "P5 window event",
    startDate: new Date(),
    endDate: new Date(),
    status: "Published",
    timezone: "UTC",
    ...overrides,
  });
}
async function makeSession(event, overrides = {}) {
  return EventSession.create({ tenantId: event.tenantId, eventId: event._id, label: "S1", date: new Date(), isVirtual: true, ...sessionTiming(), ...overrides });
}
async function makeReg(event, overrides = {}) {
  counter += 1;
  const email = `p5win-${counter}@example.test`;
  return Registration.create({
    tenantId: event.tenantId,
    registrationType: "event",
    eventId: event._id,
    attendeeSnapshot: { email, normalizedEmail: email, firstName: "Ada", lastName: "Byrne" },
    amount: 0,
    currency: "eur",
    paymentMethod: "comp",
    paymentStatus: "waived",
    status: "confirmed",
    approvalStatus: "approved",
    registeredVia: "portal",
    isActive: true,
    submittedByUserId: OWNER,
    ...overrides,
  });
}
const selfPath = (r, s) => `/api/registrations/${r._id}/sessions/${s._id}/attendance/self`;
const qrPath = (r, s) => `/api/registrations/${r._id}/sessions/${s._id}/checkin-qr`;
const crmPath = (r, s) => `/api/registrations/${r._id}/sessions/${s._id}/attendance`;
const pass = (r, s, tenantId = TENANT) =>
  signCheckinToken({ tenantId, registrationId: String(r._id), sessionId: String(s._id), expiresAt: Date.now() + 3600000 });
const scan = (token, auth = crm(), headers = {}) =>
  request(app).post("/api/registrations/checkin/scan").set("Authorization", auth).set(headers).send({ token });
const entries = async (r) => (await Registration.findById(r._id).lean()).sessionAttendance;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await OutboxEvent.init();
});
afterEach(async () => {
  for (const M of [Event, EventSession, Registration, Certificate]) await M.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } });
  await OutboxEvent.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } });
  outbox.setOutboxPublisher(null);
  jest.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
});

// ---------------------------------------------------------------------------------------------
describe("window rules (pure)", () => {
  const tz = "Europe/Dublin";
  const winter = { localDate: "2027-01-14", startTime: "10:00", endTime: "11:00", isVirtual: true };
  const summer = { localDate: "2027-07-14", startTime: "10:00", endTime: "11:00", isVirtual: true };

  it("converts wall-clock in the event zone (Dublin winter = UTC, summer = UTC+1; New York)", () => {
    expect(win.resolveSessionInstants({ timezone: tz, session: winter }).startMs).toBe(Date.parse("2027-01-14T10:00:00Z"));
    expect(win.resolveSessionInstants({ timezone: tz, session: summer }).startMs).toBe(Date.parse("2027-07-14T09:00:00Z"));
    expect(win.resolveSessionInstants({ timezone: "America/New_York", session: winter }).startMs).toBe(Date.parse("2027-01-14T15:00:00Z"));
  });

  it.each([
    ["self", win.PATHS.SELF, 15],
    ["qr-scan", win.PATHS.QR_SCAN, 60],
  ])("%s: opens exactly start-30, closes exactly end+%i (inclusive edges)", (_l, path, closeMin) => {
    const start = Date.parse("2027-01-14T10:00:00Z");
    const end = Date.parse("2027-01-14T11:00:00Z");
    const at = (ms) => win.checkWindow({ timezone: tz, session: winter, path, now: new Date(ms) });
    expect(at(start - 30 * MIN - 1).error.code).toBe("ATTENDANCE_NOT_OPEN");
    expect(at(start - 30 * MIN - 1).error.details.opensAt).toBe("2027-01-14T09:30:00.000Z");
    expect(at(start - 30 * MIN).error).toBeUndefined();
    expect(at(end + closeMin * MIN).error).toBeUndefined();
    expect(at(end + closeMin * MIN + 1).error.code).toBe("ATTENDANCE_CLOSED");
  });

  it("QR minting is allowed before opening but never after the QR close", () => {
    const end = Date.parse("2027-01-14T11:00:00Z");
    expect(win.checkWindow({ timezone: tz, session: winter, path: win.PATHS.QR_MINT, now: new Date("2027-01-01T00:00:00Z") }).error).toBeUndefined();
    expect(win.checkWindow({ timezone: tz, session: winter, path: win.PATHS.QR_MINT, now: new Date(end + 61 * MIN) }).error.code).toBe("ATTENDANCE_CLOSED");
  });

  it("self is unavailable for in-person sessions, at any time", () => {
    const r = win.checkWindow({ timezone: tz, session: { ...winter, isVirtual: false }, path: win.PATHS.SELF, now: new Date("2027-01-14T10:10:00Z") });
    expect(r.error.code).toBe("ATTENDANCE_SELF_NOT_ALLOWED_IN_PERSON");
  });

  it.each([
    ["no timezone", null, winter, "ATTENDANCE_WINDOW_UNAVAILABLE"],
    ["invalid timezone", "Mars/Olympus", winter, "ATTENDANCE_WINDOW_UNAVAILABLE"],
    ["offset instead of a zone", "+01:00", winter, "ATTENDANCE_WINDOW_UNAVAILABLE"],
    ["abbreviation instead of a zone", "IST", winter, "ATTENDANCE_WINDOW_UNAVAILABLE"],
    ["legacy session (date only, no localDate)", tz, { startTime: "10:00", endTime: "11:00", isVirtual: true }, "SESSION_TIMING_INCOMPLETE"],
    ["no end time", tz, { ...winter, endTime: null }, "SESSION_TIMING_INCOMPLETE"],
    ["no start time", tz, { ...winter, startTime: null }, "SESSION_TIMING_INCOMPLETE"],
  ])("fails closed (409) with %s - never an all-day or Dublin substitute", (_l, timezone, session, codeExpected) => {
    const r = win.checkWindow({ timezone, session, path: win.PATHS.QR_SCAN, now: new Date("2027-01-14T10:10:00Z") });
    expect(r.error.code).toBe(codeExpected);
    expect(r.error.status).toBe(409);
  });

  it("DST gap: a non-existent local time is rejected, never shifted", () => {
    const r = win.resolveSessionInstants({ timezone: tz, session: { localDate: "2027-03-28", startTime: "01:30", endTime: "03:00" } });
    expect(r.error.code).toBe("SESSION_TIME_NONEXISTENT");
  });

  it("DST overlap: an ambiguous local time needs an explicit offset; each offset picks its own instant", () => {
    const base = { localDate: "2027-10-31", startTime: "01:30", endTime: "03:00" };
    expect(win.resolveSessionInstants({ timezone: tz, session: base }).error.code).toBe("SESSION_TIME_AMBIGUOUS");
    expect(win.resolveSessionInstants({ timezone: tz, session: { ...base, startUtcOffset: "+01:00" } }).startMs).toBe(Date.parse("2027-10-31T00:30:00Z"));
    expect(win.resolveSessionInstants({ timezone: tz, session: { ...base, startUtcOffset: "+00:00" } }).startMs).toBe(Date.parse("2027-10-31T01:30:00Z"));
    expect(win.resolveSessionInstants({ timezone: tz, session: { ...base, startUtcOffset: "+05:00" } }).error.code).toBe("SESSION_UTC_OFFSET_MISMATCH");
  });

  it("overnight sessions are supported through an explicit endLocalDate", () => {
    const night = { localDate: "2027-01-14", startTime: "22:00", endTime: "02:00" };
    expect(win.resolveSessionInstants({ timezone: tz, session: night }).error.code).toBe("SESSION_END_NOT_AFTER_START");
    const r = win.resolveSessionInstants({ timezone: tz, session: { ...night, endLocalDate: "2027-01-15" } });
    expect(r.startMs).toBe(Date.parse("2027-01-14T22:00:00Z"));
    expect(r.endMs).toBe(Date.parse("2027-01-15T02:00:00Z"));
  });

  it("write-time validation: formats always; instants only when the event has a zone", () => {
    expect(win.validateSessionTiming({ startTime: "9am" }, null).code).toBe("INVALID_SESSION_TIME");
    expect(win.validateSessionTiming({ localDate: "14/01/2027" }, null).code).toBe("INVALID_SESSION_DATE");
    expect(win.validateSessionTiming({ startUtcOffset: "BST" }, null).code).toBe("INVALID_UTC_OFFSET");
    expect(win.validateSessionTiming({ localDate: "2027-10-31", startTime: "01:30", endTime: "03:00" }, null)).toBeNull();
    expect(win.validateSessionTiming({ localDate: "2027-10-31", startTime: "01:30", endTime: "03:00" }, tz).code).toBe("SESSION_TIME_AMBIGUOUS");
  });
});

// ---------------------------------------------------------------------------------------------
describe("attendee paths over HTTP", () => {
  it("virtual self inside the window -> 200; in-person self -> 409, organiser scan still works", async () => {
    const ev = await makeEvent();
    const virt = await makeSession(ev);
    const inPerson = await makeSession(ev, { label: "Room", isVirtual: false });
    const reg = await makeReg(ev);
    expect((await request(app).post(selfPath(reg, virt)).set("Authorization", portal())).status).toBe(200);
    const res = await request(app).post(selfPath(reg, inPerson)).set("Authorization", portal());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ATTENDANCE_SELF_NOT_ALLOWED_IN_PERSON");
    expect((await scan(pass(reg, inPerson))).status).toBe(200);
    const e = await entries(reg);
    expect(e.map((x) => x.method).sort()).toEqual(["manual-attendee", "qr-organizer"]);
  });

  it("self before opening -> 409 ATTENDANCE_NOT_OPEN with opensAt; after end+15 -> ATTENDANCE_CLOSED; QR still open to end+60", async () => {
    const ev = await makeEvent();
    const later = await makeSession(ev, sessionTiming({ startOffsetMin: 120, durationMin: 60 }));
    const ended = await makeSession(ev, sessionTiming({ startOffsetMin: -90, durationMin: 60 })); // ended 30 min ago
    const reg = await makeReg(ev);
    const early = await request(app).post(selfPath(reg, later)).set("Authorization", portal());
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("ATTENDANCE_NOT_OPEN");
    expect(typeof early.body.error.opensAt).toBe("string");
    const late = await request(app).post(selfPath(reg, ended)).set("Authorization", portal());
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("ATTENDANCE_CLOSED");
    expect((await scan(pass(reg, ended))).status).toBe(200);
    expect(await entries(reg)).toHaveLength(1);
  });

  it("no event timezone: self and scan fail closed (no write); CRM correction still possible with a reason", async () => {
    const ev = await makeEvent({ timezone: null });
    const s = await makeSession(ev);
    const reg = await makeReg(ev);
    const self = await request(app).post(selfPath(reg, s)).set("Authorization", portal());
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe("ATTENDANCE_WINDOW_UNAVAILABLE");
    const sc = await scan(pass(reg, s));
    expect(sc.status).toBe(409);
    expect(await entries(reg)).toHaveLength(0);
    const noReason = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "attended" });
    expect(noReason.body.error.code).toBe("CORRECTION_REASON_REQUIRED");
    const ok = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "attended", reason: "Signed the paper register" });
    expect(ok.status).toBe(200);
    expect((await entries(reg))[0]).toMatchObject({ method: "manual-crm", outsideWindow: true, reason: "Signed the paper register" });
  });

  it("legacy session without localDate fails closed (SESSION_TIMING_INCOMPLETE)", async () => {
    const ev = await makeEvent();
    const legacy = await makeSession(ev, { localDate: null });
    const reg = await makeReg(ev);
    const res = await request(app).post(selfPath(reg, legacy)).set("Authorization", portal());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SESSION_TIMING_INCOMPLETE");
  });

  it("pass minting: before opening -> 200 with expiry = QR close; after the QR close -> 409, no pass", async () => {
    const ev = await makeEvent();
    const later = await makeSession(ev, sessionTiming({ startOffsetMin: 180, durationMin: 60 }));
    const over = await makeSession(ev, sessionTiming({ startOffsetMin: -200, durationMin: 60 }));
    const reg = await makeReg(ev);
    const ok = await request(app).get(qrPath(reg, later)).set("Authorization", portal());
    expect(ok.status).toBe(200);
    const expected = win.computeWindow({ timezone: "UTC", session: later.toObject(), path: win.PATHS.QR_SCAN }).closesAt.toISOString();
    expect(ok.body.data.expiresAt).toBe(expected);
    expect(verifyCheckinToken(ok.body.data.token)).toMatchObject({ registrationId: String(reg._id) });
    const closed = await request(app).get(qrPath(reg, over)).set("Authorization", portal());
    expect(closed.status).toBe(409);
    expect(closed.body.data?.token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
describe("organiser scan", () => {
  it("requires CRM + events:write; the attendee's own pass cannot be self-redeemed", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev);
    const own = await request(app).get(qrPath(reg, s)).set("Authorization", portal());
    const token = own.body.data.token;
    expect((await scan(token, portal())).status).toBe(403);
    expect((await scan(token, crm(), { "x-test-pdp-deny": "events:write" })).status).toBe(403);
    expect((await request(app).post(`/api/public/checkin/${token}`)).status).toBe(410);
    expect(await entries(reg)).toHaveLength(0);
    const ok = await scan(token);
    expect(ok.status).toBe(200);
    expect(ok.body.data.attendee).toEqual({ firstName: "Ada", lastName: "Byrne" });
    expect(JSON.stringify(ok.body)).not.toContain("@example.test");
  });

  it("a pass from another tenant -> 403 CHECKIN_TENANT_MISMATCH, no write", async () => {
    const evB = await makeEvent({ tenantId: OTHER_TENANT });
    const sB = await makeSession(evB);
    const regB = await makeReg(evB);
    const res = await scan(pass(regB, sB, OTHER_TENANT), crm(TENANT));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CHECKIN_TENANT_MISMATCH");
    expect(await entries(regB)).toHaveLength(0);
  });

  it("tampered / expired pass -> 400", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev);
    const t = pass(reg, s);
    expect((await scan(t.slice(0, -2) + "xx")).status).toBe(400);
    const expired = signCheckinToken({ tenantId: TENANT, registrationId: String(reg._id), sessionId: String(s._id), expiresAt: Date.now() - 1 });
    expect((await scan(expired)).status).toBe(400);
  });

  it("concurrent scans of the same pass write exactly one entry", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev);
    const t = pass(reg, s);
    const results = await Promise.all(Array.from({ length: 6 }, () => scan(t)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.data.alreadyCheckedIn === false)).toHaveLength(1);
    expect(await entries(reg)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("CRM correction: reason, previous value, certificate review, audit outbox", () => {
  it("overwrite needs a reason; the previous entry is retained; the correction is audited in the outbox", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev, { sessionAttendance: [{ sessionId: s._id, status: "attended", method: "qr-organizer", markedAt: new Date() }] });
    const noReason = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "absent" });
    expect(noReason.status).toBe(400);
    expect(await OutboxEvent.countDocuments({ tenantId: TENANT })).toBe(0);
    const ok = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "absent", reason: "Scanned in error" });
    expect(ok.status).toBe(200);
    const [e] = await entries(reg);
    expect(e).toMatchObject({ status: "absent", method: "manual-crm", markedBy: CRM_USER, reason: "Scanned in error", outsideWindow: false });
    expect(e.previous).toMatchObject({ status: "attended", method: "qr-organizer" });
    const rows = await OutboxEvent.find({ tenantId: TENANT }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routingKey: "events.attendance.corrected.v1", status: "PENDING" });
    expect(rows[0].data).toMatchObject({ registrationId: String(reg._id), sessionId: String(s._id), reason: "Scanned in error", from: { status: "attended" }, to: { status: "absent" } });
  });

  it("new entry inside the window needs no reason", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev);
    const ok = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "attended" });
    expect(ok.status).toBe(200);
    expect((await entries(reg))[0]).toMatchObject({ outsideWindow: false, reason: null });
  });

  it("attended -> absent with an ISSUED certificate flags it for review (never revoked) and audits the flag", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev, { sessionAttendance: [{ sessionId: s._id, status: "attended", method: "manual-crm", markedAt: new Date() }] });
    const cert = await Certificate.create({ tenantId: TENANT, registrationId: reg._id, profileId: "p1", status: "issued", issuedAt: new Date() });
    const res = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "absent", reason: "Left at the start" });
    expect(res.status).toBe(200);
    const fresh = await Certificate.findById(cert._id).lean();
    expect(fresh).toMatchObject({ status: "issued", reviewRequired: true, reviewReason: "ATTENDANCE_DOWNGRADED", reviewFlaggedBy: CRM_USER });
    const keys = (await OutboxEvent.find({ tenantId: TENANT }).lean()).map((r) => r.routingKey).sort();
    expect(keys).toEqual(["events.attendance.corrected.v1", "events.certificate.review_flagged.v1"]);
  });

  it("absent -> attended (not a downgrade) does not flag the certificate", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev, { sessionAttendance: [{ sessionId: s._id, status: "absent", method: "manual-crm", markedAt: new Date() }] });
    const cert = await Certificate.create({ tenantId: TENANT, registrationId: reg._id, profileId: "p1", status: "issued" });
    await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "attended", reason: "Late arrival confirmed" });
    expect((await Certificate.findById(cert._id).lean()).reviewRequired).toBe(false);
  });

  it("two concurrent corrections of the same entry: one wins, the other 409 - one audit row", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev, { sessionAttendance: [{ sessionId: s._id, status: "attended", method: "qr-organizer", markedAt: new Date() }] });
    const [a, b] = await Promise.all([
      request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "absent", reason: "r1" }),
      request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "absent", reason: "r2" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await OutboxEvent.countDocuments({ tenantId: TENANT })).toBe(1);
  });

  it("an outbox write failure rolls the whole correction back (no unaudited change)", async () => {
    const ev = await makeEvent();
    const s = await makeSession(ev);
    const reg = await makeReg(ev);
    jest.spyOn(OutboxEvent, "updateOne").mockRejectedValueOnce(new Error("outbox down"));
    const res = await request(app).put(crmPath(reg, s)).set("Authorization", crm()).send({ status: "attended" });
    expect(res.status).toBe(500);
    expect(await entries(reg)).toHaveLength(0);
    expect(await OutboxEvent.countDocuments({ tenantId: TENANT })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("timezone + schedule changes are explicit and audited", () => {
  const send = (method, path, body) => request(app)[method](path).set("Authorization", crm()).send(body);

  it("create stores an explicit timezone (crm_explicit); an invalid one is 400; generic update cannot change it", async () => {
    const bad = await send("post", "/api/events", { title: "x", startDate: "2030-01-01", endDate: "2030-01-01", timezone: "+01:00" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_TIMEZONE");
    const ev = await makeEvent({ status: "Draft", timezone: null });
    const viaUpdate = await send("put", `/api/events/${ev._id}`, { timezone: "Europe/Dublin" });
    expect(viaUpdate.status).toBe(400);
    expect(viaUpdate.body.error.code).toBe("USE_TIMEZONE_ENDPOINT");
  });

  it("PUT /events/:id/timezone: draft without registrations -> no reason, no audit; published -> reason + audit", async () => {
    const draft = await makeEvent({ status: "Draft", timezone: null });
    const d = await send("put", `/api/events/${draft._id}/timezone`, { timezone: "Europe/Dublin" });
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({ timezone: "Europe/Dublin", timezoneSource: "crm_explicit", timezoneSetBy: CRM_USER });
    expect(await OutboxEvent.countDocuments({ tenantId: TENANT })).toBe(0);

    const pub = await makeEvent({ timezone: null });
    const noReason = await send("put", `/api/events/${pub._id}/timezone`, { timezone: "Europe/Dublin" });
    expect(noReason.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    const ok = await send("put", `/api/events/${pub._id}/timezone`, { timezone: "Europe/Dublin", scheduleChangeReason: "Event created before timezones" });
    expect(ok.status).toBe(200);
    const [row] = await OutboxEvent.find({ tenantId: TENANT }).lean();
    expect(row).toMatchObject({ routingKey: "events.session.schedule_changed.v1" });
    expect(row.data).toMatchObject({ scope: "event-timezone", changes: { timezone: { from: null, to: "Europe/Dublin" } }, reason: "Event created before timezones" });
  });

  it("completed events are locked", async () => {
    const done = await makeEvent({ status: "Completed" });
    const res = await send("put", `/api/events/${done._id}/timezone`, { timezone: "Europe/Dublin", scheduleChangeReason: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EVENT_SCHEDULE_LOCKED");
  });

  it("session update on a published event: an unchanged re-save needs no reason; a timing change needs one and is audited", async () => {
    const ev = await makeEvent({ timezone: "Europe/Dublin" });
    const s = await makeSession(ev, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    const resave = await send("put", `/api/events/${ev._id}/sessions/${s._id}`, { label: "S1", localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    expect(resave.status).toBe(200);
    const noReason = await send("put", `/api/events/${ev._id}/sessions/${s._id}`, { startTime: "10:30" });
    expect(noReason.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    const ok = await send("put", `/api/events/${ev._id}/sessions/${s._id}`, { startTime: "10:30", scheduleChangeReason: "Speaker delayed" });
    expect(ok.status).toBe(200);
    const [row] = await OutboxEvent.find({ tenantId: TENANT }).lean();
    expect(row.data).toMatchObject({ scope: "session-update", changes: { startTime: { from: "10:00", to: "10:30" } } });
  });

  it("session timing is validated against the event zone: DST-ambiguous time needs an offset", async () => {
    const ev = await makeEvent({ status: "Draft", timezone: "Europe/Dublin" });
    const amb = await send("post", `/api/events/${ev._id}/sessions`, { label: "Night", date: "2030-10-27", localDate: "2030-10-27", startTime: "01:30", endTime: "03:00" });
    expect(amb.status).toBe(400);
    expect(amb.body.error.code).toBe("SESSION_TIME_AMBIGUOUS");
    const ok = await send("post", `/api/events/${ev._id}/sessions`, { label: "Night", date: "2030-10-27", localDate: "2030-10-27", startTime: "01:30", startUtcOffset: "+00:00", endTime: "03:00" });
    expect(ok.status).toBe(201);
    const overnight = await send("post", `/api/events/${ev._id}/sessions`, { label: "Gala", date: "2030-01-14", localDate: "2030-01-14", endLocalDate: "2030-01-15", startTime: "22:00", endTime: "01:00" });
    expect(overnight.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------
describe("outbox relay: confirmed, retried, deduplicated", () => {
  // The relay drains the whole collection - start from an empty one (other suites leave rows).
  beforeEach(async () => {
    await OutboxEvent.deleteMany({});
  });
  async function seed(eventKey = "test.0123456789abcdef") {
    await outbox.enqueueOutboxEvent({ eventKey, tenantId: TENANT, routingKey: "events.attendance.corrected.v1", data: { a: 1 } });
    return eventKey;
  }

  it("the same eventKey enqueued twice is stored once", async () => {
    await seed();
    await seed();
    expect(await OutboxEvent.countDocuments({ tenantId: TENANT })).toBe(1);
  });

  it("an unconfirmed publish stays PENDING with backoff; a later confirmed publish marks it PUBLISHED with the same eventId", async () => {
    const key = await seed();
    const seen = [];
    outbox.setOutboxPublisher(async (row) => {
      seen.push(row.eventKey);
      return seen.length === 1 ? { ok: false, error: "broker nack" } : { ok: true };
    });
    const t0 = new Date();
    const first = await outbox.relayOutboxOnce({ now: t0 });
    expect(first).toMatchObject({ due: 1, published: 0, failed: 1 });
    let row = await OutboxEvent.findOne({ eventKey: key }).lean();
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastError: "broker nack" });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime());
    expect((await outbox.relayOutboxOnce({ now: t0 })).due).toBe(0); // backoff respected
    const second = await outbox.relayOutboxOnce({ now: new Date(t0.getTime() + 5000) });
    expect(second.published).toBe(1);
    row = await OutboxEvent.findOne({ eventKey: key }).lean();
    expect(row.status).toBe("PUBLISHED");
    expect(seen).toEqual([key, key]);
  });

  it("a publisher that throws is treated as unconfirmed, never as published", async () => {
    const key = await seed();
    outbox.setOutboxPublisher(async () => {
      throw new Error("channel closed");
    });
    await outbox.relayOutboxOnce();
    expect((await OutboxEvent.findOne({ eventKey: key }).lean()).status).toBe("PENDING");
  });

  it("the default publisher uses the middleware's confirmed publish on events.events with eventId = eventKey", async () => {
    const mw = require("@projectShell/rabbitmq-middleware");
    const spy = jest.spyOn(mw.publisher, "publishConfirmed").mockResolvedValue({ success: true });
    const key = await seed();
    await outbox.relayOutboxOnce();
    expect(spy).toHaveBeenCalledWith(
      "events.attendance.corrected.v1",
      { a: 1 },
      expect.objectContaining({ eventId: key, tenantId: TENANT, exchange: "events.events", routingKey: "events.attendance.corrected.v1" }),
    );
    expect((await OutboxEvent.findOne({ eventKey: key }).lean()).status).toBe("PUBLISHED");
  });
});
