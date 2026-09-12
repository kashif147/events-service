// Microsoft Graph client-credentials + attendance-report client for Teams
// meetings - used only by jobs/onlineAttendanceSyncSweep.js. Requires its own
// Azure AD app registration (application permissions
// OnlineMeetings.Read.All / OnlineMeetingArtifact.Read.All, admin-consented) -
// deliberately separate from communication-service's own Graph app
// (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET there), not a shared
// secret between services.
const axios = require("axios");

const MSGRAPH_TENANT_ID = process.env.MSGRAPH_TENANT_ID;
const MSGRAPH_CLIENT_ID = process.env.MSGRAPH_CLIENT_ID;
const MSGRAPH_CLIENT_SECRET = process.env.MSGRAPH_CLIENT_SECRET;

function isConfigured() {
  return Boolean(MSGRAPH_TENANT_ID && MSGRAPH_CLIENT_ID && MSGRAPH_CLIENT_SECRET);
}

let cachedToken = null; // { accessToken, expiresAt }

async function getGraphAccessToken() {
  if (!isConfigured()) {
    throw new Error("Teams/Graph integration is not configured (MSGRAPH_TENANT_ID/MSGRAPH_CLIENT_ID/MSGRAPH_CLIENT_SECRET)");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const response = await axios.post(
    `https://login.microsoftonline.com/${MSGRAPH_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: MSGRAPH_CLIENT_ID,
      client_secret: MSGRAPH_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 },
  );

  cachedToken = {
    accessToken: response.data.access_token,
    expiresAt: Date.now() + (response.data.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

/** OData single-quote escaping for a $filter string literal. */
function odataEscape(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * @param {string} organizerUpn - the Teams meeting organizer's UPN (EventSession.meeting.organizerUpn)
 * @param {string} joinUrl - the full Teams join link (EventSession.meeting.joinUrl) - Graph looks
 *   the meeting up by exact JoinWebUrl match, there's no separate short meeting id to key off.
 * @returns {Promise<Array<{email: string, durationSeconds: number}>>}
 */
async function getAttendanceReport(organizerUpn, joinUrl) {
  const accessToken = await getGraphAccessToken();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerUpn)}/onlineMeetings`;

  const meetingRes = await axios.get(base, {
    headers,
    params: { $filter: `JoinWebUrl eq '${odataEscape(joinUrl)}'` },
    timeout: 15000,
  });
  const meeting = meetingRes.data?.value?.[0];
  if (!meeting?.id) return [];

  const reportsRes = await axios.get(`${base}/${meeting.id}/attendanceReports`, { headers, timeout: 15000 });
  const reports = reportsRes.data?.value || [];
  // Attendance reports are ordered oldest-first; the last one reflects the
  // meeting's final state.
  const latestReport = reports[reports.length - 1];
  if (!latestReport?.id) return [];

  const recordsRes = await axios.get(
    `${base}/${meeting.id}/attendanceReports/${latestReport.id}/attendanceRecords`,
    { headers, timeout: 15000 },
  );
  const records = recordsRes.data?.value || [];

  return records
    .map((r) => ({
      email: String(r.emailAddress || "").trim().toLowerCase(),
      durationSeconds: r.totalAttendanceInSeconds || 0,
    }))
    .filter((r) => r.email);
}

module.exports = { isConfigured, getGraphAccessToken, getAttendanceReport };
