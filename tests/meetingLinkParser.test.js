const { parseMeetingLink } = require("../services/meetingLinkParser.js");

describe("parseMeetingLink", () => {
  it("detects a Zoom link and extracts the numeric meeting id", () => {
    expect(parseMeetingLink("https://zoom.us/j/1234567890?pwd=abc")).toEqual({
      provider: "zoom",
      externalMeetingId: "1234567890",
    });
    expect(parseMeetingLink("https://us02web.zoom.us/j/9876543210")).toEqual({
      provider: "zoom",
      externalMeetingId: "9876543210",
    });
  });

  it("detects a Teams link with no separately-extractable meeting id", () => {
    expect(
      parseMeetingLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"),
    ).toEqual({ provider: "teams", externalMeetingId: null });
  });

  it("treats an unrecognized link (e.g. Google Meet) as no provider", () => {
    expect(parseMeetingLink("https://meet.google.com/abc-defg-hij")).toEqual({
      provider: null,
      externalMeetingId: null,
    });
  });

  it("handles empty/missing input", () => {
    expect(parseMeetingLink(null)).toEqual({ provider: null, externalMeetingId: null });
    expect(parseMeetingLink("")).toEqual({ provider: null, externalMeetingId: null });
    expect(parseMeetingLink(undefined)).toEqual({ provider: null, externalMeetingId: null });
  });
});
