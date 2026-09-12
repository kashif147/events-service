// Detects which provider (if any) a pasted meeting link belongs to, and
// extracts what each provider's own attendance-report API actually needs to
// look the meeting up later - see zoomIntegration.client.js/
// msGraphMeetings.client.js. Google Meet (and anything else) is left as a
// plain link with no provider - no attendance API integration exists for it.
const ZOOM_MEETING_ID_RE = /zoom\.(?:us|com)\/j\/(\d+)/i;
const TEAMS_HOST_RE = /teams\.microsoft\.com/i;

/**
 * @param {string|null|undefined} joinUrl
 * @returns {{provider: "zoom"|"teams"|null, externalMeetingId: string|null}}
 */
function parseMeetingLink(joinUrl) {
  if (!joinUrl || typeof joinUrl !== "string") {
    return { provider: null, externalMeetingId: null };
  }

  const zoomMatch = joinUrl.match(ZOOM_MEETING_ID_RE);
  if (zoomMatch) {
    return { provider: "zoom", externalMeetingId: zoomMatch[1] };
  }

  if (TEAMS_HOST_RE.test(joinUrl)) {
    // Teams/Graph looks a meeting up by matching JoinWebUrl exactly (see
    // msGraphMeetings.client.js) - there's no separate short "meeting ID" to
    // parse out of a Teams join link the way Zoom's /j/{id} works.
    return { provider: "teams", externalMeetingId: null };
  }

  return { provider: null, externalMeetingId: null };
}

module.exports = { parseMeetingLink };
