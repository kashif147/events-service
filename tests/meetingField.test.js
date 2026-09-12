const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const app = require("../app");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");

const TENANT_ID = "tenant-meeting-field-test";

function authHeader() {
  const token = jwt.sign({ sub: "user-1", tenantId: TENANT_ID, roles: [] }, process.env.JWT_SECRET);
  return `Bearer ${token}`;
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(async () => {
  await Event.deleteMany({ tenantId: TENANT_ID });
  await EventSession.deleteMany({ tenantId: TENANT_ID });
});

afterAll(async () => {
  await mongoose.disconnect();
});

async function createEventDoc() {
  return Event.create({
    tenantId: TENANT_ID,
    title: "Meeting Field Test Event",
    startDate: new Date("2020-01-01T09:00:00Z"),
    endDate: new Date("2020-01-01T17:00:00Z"),
    status: "Draft",
  });
}

describe("POST /events/:id/sessions - meeting field detection", () => {
  it("detects Zoom and extracts the meeting id from a pasted joinUrl", async () => {
    const event = await createEventDoc();
    const res = await request(app)
      .post(`/api/events/${event._id}/sessions`)
      .set("Authorization", authHeader())
      .send({ label: "Day 1", date: event.startDate, isVirtual: true, joinUrl: "https://zoom.us/j/1234567890" });

    expect(res.status).toBe(201);
    expect(res.body.data.meeting).toMatchObject({ provider: "zoom", externalMeetingId: "1234567890" });
  });

  it("detects Teams and stores organizerUpn alongside the joinUrl", async () => {
    const event = await createEventDoc();
    const res = await request(app)
      .post(`/api/events/${event._id}/sessions`)
      .set("Authorization", authHeader())
      .send({
        label: "Day 1",
        date: event.startDate,
        isVirtual: true,
        joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
        organizerUpn: "organizer@tenant.onmicrosoft.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.meeting).toMatchObject({
      provider: "teams",
      organizerUpn: "organizer@tenant.onmicrosoft.com",
    });
  });
});

describe("PUT /events/:id/sessions/:sessionId - meeting field updates", () => {
  it("updates organizerUpn alone without clobbering the existing joinUrl/provider", async () => {
    const event = await createEventDoc();
    const created = await request(app)
      .post(`/api/events/${event._id}/sessions`)
      .set("Authorization", authHeader())
      .send({
        label: "Day 1",
        date: event.startDate,
        isVirtual: true,
        joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      });
    const sessionId = created.body.data._id;

    const res = await request(app)
      .put(`/api/events/${event._id}/sessions/${sessionId}`)
      .set("Authorization", authHeader())
      .send({ organizerUpn: "organizer@tenant.onmicrosoft.com" });

    expect(res.status).toBe(200);
    expect(res.body.data.meeting).toMatchObject({
      provider: "teams",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      organizerUpn: "organizer@tenant.onmicrosoft.com",
    });
  });

  it("a plain time-only update does not clear the existing meeting field", async () => {
    const event = await createEventDoc();
    const created = await request(app)
      .post(`/api/events/${event._id}/sessions`)
      .set("Authorization", authHeader())
      .send({ label: "Day 1", date: event.startDate, isVirtual: true, joinUrl: "https://zoom.us/j/1234567890" });
    const sessionId = created.body.data._id;

    const res = await request(app)
      .put(`/api/events/${event._id}/sessions/${sessionId}`)
      .set("Authorization", authHeader())
      .send({ startTime: "10:00" });

    expect(res.status).toBe(200);
    expect(res.body.data.meeting).toMatchObject({ provider: "zoom", externalMeetingId: "1234567890" });
  });
});
