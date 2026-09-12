const mongoose = require("mongoose");

jest.mock("../services/zoomIntegration.client.js");
jest.mock("../services/msGraphMeetings.client.js");

const zoomClient = require("../services/zoomIntegration.client.js");
const graphClient = require("../services/msGraphMeetings.client.js");
const { syncSessionAttendance, scheduledMinutesForSession, registrationAppliesToSession } = require("../services/onlineAttendanceSync.service.js");
const Registration = require("../models/registration.model.js");

const TENANT_ID = "tenant-online-attendance-test";

describe("scheduledMinutesForSession", () => {
  it("computes minutes between startTime and endTime", () => {
    expect(scheduledMinutesForSession({ startTime: "09:00", endTime: "10:30" })).toBe(90);
  });
  it("returns null when times are missing or invalid", () => {
    expect(scheduledMinutesForSession({ startTime: null, endTime: "10:30" })).toBeNull();
    expect(scheduledMinutesForSession({ startTime: "10:00", endTime: "09:00" })).toBeNull();
  });
});

describe("registrationAppliesToSession", () => {
  const session = { _id: "s1" };
  it("applies to every session when sessionIds is empty (non-partial default)", () => {
    expect(registrationAppliesToSession({ sessionIds: [] }, session)).toBe(true);
  });
  it("only applies when the session is explicitly included", () => {
    expect(registrationAppliesToSession({ sessionIds: ["s1"] }, session)).toBe(true);
    expect(registrationAppliesToSession({ sessionIds: ["s2"] }, session)).toBe(false);
  });
});

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
  await Registration.deleteMany({ tenantId: TENANT_ID });
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("syncSessionAttendance", () => {
  const eventId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const event = { _id: eventId, attendanceMinPercent: 80 };
  const session = {
    _id: sessionId,
    startTime: "09:00",
    endTime: "10:00", // 60 scheduled minutes
    meeting: { provider: "zoom", externalMeetingId: "111" },
  };

  it("marks a registrant attended when connected time meets the threshold, absent when it doesn't, and absent when never seen at all", async () => {
    const attendedReg = await createRegistrationDoc(eventId);
    const partialReg = await createRegistrationDoc(eventId);
    const noShowReg = await createRegistrationDoc(eventId);

    zoomClient.getMeetingParticipants.mockResolvedValue([
      { email: attendedReg.attendeeSnapshot.normalizedEmail, durationSeconds: 55 * 60 }, // 55/60 = 92%
      { email: partialReg.attendeeSnapshot.normalizedEmail, durationSeconds: 10 * 60 }, // 10/60 = 17%
      // noShowReg never appears in the participant list at all
    ]);

    const result = await syncSessionAttendance({ event, session, tenantId: TENANT_ID });
    expect(result.synced).toBe(3);

    const [reloadedAttended, reloadedPartial, reloadedNoShow] = await Promise.all([
      Registration.findById(attendedReg._id),
      Registration.findById(partialReg._id),
      Registration.findById(noShowReg._id),
    ]);

    expect(reloadedAttended.sessionAttendance[0]).toMatchObject({ status: "attended", method: "zoom", connectedMinutes: 55 });
    expect(reloadedPartial.sessionAttendance[0]).toMatchObject({ status: "absent", method: "zoom", connectedMinutes: 10 });
    expect(reloadedNoShow.sessionAttendance[0]).toMatchObject({ status: "absent", method: "zoom", connectedMinutes: 0 });
  });

  it("never overwrites an existing manual-crm entry for the same session", async () => {
    const registration = await createRegistrationDoc(eventId, {
      sessionAttendance: [{ sessionId, status: "attended", method: "manual-crm", markedAt: new Date(), markedBy: "user-1" }],
    });
    zoomClient.getMeetingParticipants.mockResolvedValue([
      { email: registration.attendeeSnapshot.normalizedEmail, durationSeconds: 0 },
    ]);

    await syncSessionAttendance({ event, session, tenantId: TENANT_ID });

    const reloaded = await Registration.findById(registration._id);
    expect(reloaded.sessionAttendance).toHaveLength(1);
    expect(reloaded.sessionAttendance[0]).toMatchObject({ status: "attended", method: "manual-crm" });
  });

  it("dispatches to the Graph client for a Teams session", async () => {
    const registration = await createRegistrationDoc(eventId);
    const teamsSession = {
      _id: sessionId,
      startTime: "09:00",
      endTime: "10:00",
      meeting: { provider: "teams", joinUrl: "https://teams.microsoft.com/l/meetup-join/abc", organizerUpn: "organizer@tenant.onmicrosoft.com" },
    };
    graphClient.getAttendanceReport.mockResolvedValue([
      { email: registration.attendeeSnapshot.normalizedEmail, durationSeconds: 60 * 60 },
    ]);

    await syncSessionAttendance({ event, session: teamsSession, tenantId: TENANT_ID });

    expect(graphClient.getAttendanceReport).toHaveBeenCalledWith(
      "organizer@tenant.onmicrosoft.com",
      "https://teams.microsoft.com/l/meetup-join/abc",
    );
    const reloaded = await Registration.findById(registration._id);
    expect(reloaded.sessionAttendance[0]).toMatchObject({ status: "attended", method: "teams" });
  });
});
