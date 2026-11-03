/**
 * P5 rollout switch SCHEDULE_REASON_MODE (transition | enforce, default enforce).
 *
 * The deployed CRM predates scheduleChangeReason, so during the events -> CRM rollout window an audited
 * schedule change (Published event or one with registrations) without a reason would be 400. In
 * "transition" it is accepted, still audited through the transactional outbox with
 * reasonSource "legacy-client", and logged with ids only. Any other value enforces.
 *
 * Real app + real Mongo (single-node replica set: transactions). PDP mocked (tests/helpers/pdpMock.js).
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
const OutboxEvent = require("../models/outboxEvent.model.js");
const { scheduleReasonMode, reasonGate } = require("../services/scheduleChange.service.js");
const { sessionTiming } = require("./helpers/attendanceTiming.js");

const TENANT = "aaaaaaaaaaaaaaaaaaaaaa31";
const CRM_USER = "p5mode-crm-1";
const crm = () => `Bearer ${jwt.sign({ sub: CRM_USER, tenantId: TENANT, roles: [], userType: "CRM" }, process.env.JWT_SECRET)}`;
const send = (method, path, body) => request(app)[method](path).set("Authorization", crm()).send(body);

const makeEvent = (o = {}) =>
  Event.create({ tenantId: TENANT, title: "P5 mode event", startDate: new Date(), endDate: new Date(), status: "Published", timezone: "Europe/Dublin", ...o });
const makeSession = (ev, o = {}) =>
  EventSession.create({ tenantId: TENANT, eventId: ev._id, label: "S1", date: new Date(), isVirtual: true, ...sessionTiming(), ...o });
const auditRows = () => OutboxEvent.find({ tenantId: TENANT, routingKey: "events.session.schedule_changed.v1" }).lean();

const ORIGINAL_MODE = process.env.SCHEDULE_REASON_MODE;
beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  await OutboxEvent.init();
});
afterEach(async () => {
  for (const M of [Event, EventSession, Registration, OutboxEvent]) await M.deleteMany({ tenantId: TENANT });
  if (ORIGINAL_MODE === undefined) delete process.env.SCHEDULE_REASON_MODE;
  else process.env.SCHEDULE_REASON_MODE = ORIGINAL_MODE;
  jest.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe("mode parsing", () => {
  it.each([
    [undefined, "enforce"],
    ["", "enforce"],
    ["enforce", "enforce"],
    ["transition", "transition"],
    ["TRANSITION", "enforce"],
    ["true", "enforce"],
    [" transition", "enforce"],
  ])("SCHEDULE_REASON_MODE=%p -> %s", (value, expected) => {
    if (value === undefined) delete process.env.SCHEDULE_REASON_MODE;
    else process.env.SCHEDULE_REASON_MODE = value;
    expect(scheduleReasonMode()).toBe(expected);
  });

  it("unaudited changes never need a reason in either mode", () => {
    for (const mode of ["enforce", "transition"]) {
      process.env.SCHEDULE_REASON_MODE = mode;
      expect(reasonGate({ audited: false, reason: null })).toEqual({ reasonSource: null });
    }
  });
});

describe("enforce (default): every audited schedule change without a reason is 400 and writes nothing", () => {
  beforeEach(() => {
    delete process.env.SCHEDULE_REASON_MODE;
  });

  it("timezone, session add, session update, session delete", async () => {
    const ev = await makeEvent({ timezone: null });
    const tz = await send("put", `/api/events/${ev._id}/timezone`, { timezone: "Europe/Dublin" });
    expect(tz.status).toBe(400);
    expect(tz.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    expect((await Event.findById(ev._id).lean()).timezone ?? null).toBeNull();

    const pub = await makeEvent();
    const add = await send("post", `/api/events/${pub._id}/sessions`, { label: "New", date: "2030-01-14", localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    expect(add.status).toBe(400);
    expect(add.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    expect(await EventSession.countDocuments({ eventId: pub._id, isDeleted: { $ne: true } })).toBe(0);

    const s = await makeSession(pub, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    const upd = await send("put", `/api/events/${pub._id}/sessions/${s._id}`, { startTime: "10:30" });
    expect(upd.status).toBe(400);
    expect(upd.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    expect((await EventSession.findById(s._id).lean()).startTime).toBe("10:00");

    const del = await send("delete", `/api/events/${pub._id}/sessions/${s._id}`);
    expect(del.status).toBe(400);
    expect(del.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    expect((await EventSession.findById(s._id).lean()).isDeleted).not.toBe(true);

    expect(await auditRows()).toHaveLength(0);
  });

  it("an unknown mode value also enforces", async () => {
    process.env.SCHEDULE_REASON_MODE = "off";
    const pub = await makeEvent();
    const s = await makeSession(pub, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    const upd = await send("put", `/api/events/${pub._id}/sessions/${s._id}`, { startTime: "10:30" });
    expect(upd.status).toBe(400);
    expect(upd.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
  });
});

describe("transition: reasonless audited changes are accepted, audited as legacy-client and logged with ids only", () => {
  beforeEach(() => {
    process.env.SCHEDULE_REASON_MODE = "transition";
  });

  it("timezone set on a Published event without a reason", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const ev = await makeEvent({ timezone: null });
    const res = await send("put", `/api/events/${ev._id}/timezone`, { timezone: "Europe/Dublin" });
    expect(res.status).toBe(200);
    expect((await Event.findById(ev._id).lean()).timezone).toBe("Europe/Dublin");
    const [row] = await auditRows();
    expect(row.data).toMatchObject({ scope: "event-timezone", reason: null, reasonSource: "legacy-client", actorUserId: CRM_USER });

    const logged = warn.mock.calls.filter((c) => String(c[0]).includes("[schedule-change]"));
    expect(logged).toHaveLength(1);
    expect(Object.keys(logged[0][1]).sort()).toEqual(["eventId", "scope", "sessionId", "tenantId"]);
    expect(logged[0][1]).toEqual({ scope: "event-timezone", tenantId: TENANT, eventId: String(ev._id), sessionId: null });
  });

  it("session add / update / delete without a reason (deployed-CRM payload shape: no localDate, no reason)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const pub = await makeEvent();
    const add = await send("post", `/api/events/${pub._id}/sessions`, { label: "Legacy", date: "2030-01-14T00:00:00.000Z", startTime: "10:00", endTime: "11:00" });
    expect(add.status).toBe(201);
    const sid = add.body.data._id;

    const upd = await send("put", `/api/events/${pub._id}/sessions/${sid}`, { startTime: "10:30" });
    expect(upd.status).toBe(200);
    expect((await EventSession.findById(sid).lean()).startTime).toBe("10:30");

    const del = await send("delete", `/api/events/${pub._id}/sessions/${sid}`);
    expect(del.status).toBe(200);
    expect((await EventSession.findById(sid).lean()).isDeleted).toBe(true);

    const rows = await auditRows();
    expect(rows.map((r) => r.data.scope).sort()).toEqual(["session-add", "session-delete", "session-update"]);
    for (const r of rows) expect(r.data).toMatchObject({ reason: null, reasonSource: "legacy-client" });
  });

  it("an event with registrations (Draft) is audited the same way", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const draft = await makeEvent({ status: "Draft" });
    await Registration.create({
      tenantId: TENANT, registrationType: "event", eventId: draft._id, amount: 0, currency: "eur", paymentMethod: "comp",
      paymentStatus: "waived", status: "pending", approvalStatus: "pending_review", registeredVia: "crm", isActive: true,
      attendeeSnapshot: { email: "p5mode@example.test", normalizedEmail: "p5mode@example.test", firstName: "A", lastName: "B" },
    });
    const s = await makeSession(draft, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    const upd = await send("put", `/api/events/${draft._id}/sessions/${s._id}`, { endTime: "12:00" });
    expect(upd.status).toBe(200);
    const [row] = await auditRows();
    expect(row.data).toMatchObject({ scope: "session-update", reasonSource: "legacy-client" });
  });

  it("a supplied reason is kept and marked client; unaudited drafts stay unaudited", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const pub = await makeEvent();
    const s = await makeSession(pub, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    const ok = await send("put", `/api/events/${pub._id}/sessions/${s._id}`, { startTime: "10:30", scheduleChangeReason: "Speaker delayed" });
    expect(ok.status).toBe(200);
    const [row] = await auditRows();
    expect(row.data).toMatchObject({ reason: "Speaker delayed", reasonSource: "client" });

    const draft = await makeEvent({ status: "Draft" });
    const ds = await makeSession(draft, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    expect((await send("put", `/api/events/${draft._id}/sessions/${ds._id}`, { startTime: "09:00" })).status).toBe(200);
    expect(await auditRows()).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[schedule-change]"))).toHaveLength(0);
  });

  it("transition does not relax anything else: invalid reason type, locked events, timing validation", async () => {
    const pub = await makeEvent();
    const s = await makeSession(pub, { localDate: "2030-01-14", startTime: "10:00", endTime: "11:00" });
    const badReason = await send("put", `/api/events/${pub._id}/sessions/${s._id}`, { startTime: "10:30", scheduleChangeReason: 42 });
    expect(badReason.status).toBe(400);
    expect(badReason.body.error.code).toBe("INVALID_REASON");
    const badTime = await send("put", `/api/events/${pub._id}/sessions/${s._id}`, { startTime: "25:00" });
    expect(badTime.status).toBe(400);
    const done = await makeEvent({ status: "Completed" });
    const locked = await send("put", `/api/events/${done._id}/timezone`, { timezone: "Europe/London" });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("EVENT_SCHEDULE_LOCKED");
    expect(await auditRows()).toHaveLength(0);
  });
});
