const { computeRegistrationAttendanceRollup } = require("../services/attendanceRollup.service.js");

const sessions = [{ _id: "s1" }, { _id: "s2" }, { _id: "s3" }];

describe("computeRegistrationAttendanceRollup", () => {
  it("requires every event session when allowPartialAttendance is false", () => {
    const event = { allowPartialAttendance: false };
    const registration = {
      sessionIds: ["s1"], // registered for only one day, but full attendance is required anyway
      sessionAttendance: [
        { sessionId: "s1", status: "attended" },
        { sessionId: "s2", status: "attended" },
        // s3 missing
      ],
    };
    expect(computeRegistrationAttendanceRollup({ registration, event, sessions })).toBe("no-show");
  });

  it("passes when every event session is attended and allowPartialAttendance is false", () => {
    const event = { allowPartialAttendance: false };
    const registration = {
      sessionAttendance: [
        { sessionId: "s1", status: "attended" },
        { sessionId: "s2", status: "attended" },
        { sessionId: "s3", status: "attended" },
      ],
    };
    expect(computeRegistrationAttendanceRollup({ registration, event, sessions })).toBe("attended");
  });

  it("only requires the attendee's own registered sessions when allowPartialAttendance is true", () => {
    const event = { allowPartialAttendance: true };
    const registration = {
      sessionIds: ["s1", "s2"], // didn't register for s3 at all
      sessionAttendance: [
        { sessionId: "s1", status: "attended" },
        { sessionId: "s2", status: "attended" },
      ],
    };
    expect(computeRegistrationAttendanceRollup({ registration, event, sessions })).toBe("attended");
  });

  it("still fails if one of the attendee's own registered sessions was missed, even with allowPartialAttendance", () => {
    const event = { allowPartialAttendance: true };
    const registration = {
      sessionIds: ["s1", "s2"],
      sessionAttendance: [{ sessionId: "s1", status: "attended" }],
    };
    expect(computeRegistrationAttendanceRollup({ registration, event, sessions })).toBe("no-show");
  });

  it("an explicit 'absent' entry does not count as attended", () => {
    const event = { allowPartialAttendance: false };
    const registration = {
      sessionAttendance: [
        { sessionId: "s1", status: "attended" },
        { sessionId: "s2", status: "absent" },
        { sessionId: "s3", status: "attended" },
      ],
    };
    expect(computeRegistrationAttendanceRollup({ registration, event, sessions })).toBe("no-show");
  });

  it("treats an event with no sessions as attended (nothing to gate on)", () => {
    const event = { allowPartialAttendance: false };
    const registration = { sessionAttendance: [] };
    expect(computeRegistrationAttendanceRollup({ registration, event, sessions: [] })).toBe("attended");
  });
});
