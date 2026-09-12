// Zoom Server-to-Server OAuth + Report API client - used only by
// jobs/onlineAttendanceSyncSweep.js to pull each Zoom session's actual
// participant durations after it ends (poll-based; there is no webhook
// receiver in this design - see that job's file comment for why). Requires
// a Zoom Server-to-Server OAuth app with the report:read:admin (or
// meeting:read:admin) scope.
const axios = require("axios");

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

function isConfigured() {
  return Boolean(ZOOM_ACCOUNT_ID && ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET);
}

let cachedToken = null; // { accessToken, expiresAt }

async function getZoomAccessToken() {
  if (!isConfigured()) {
    throw new Error("Zoom integration is not configured (ZOOM_ACCOUNT_ID/ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET)");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.accessToken;
  }

  const basicAuth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64");
  const response = await axios.post(
    "https://zoom.us/oauth/token",
    null,
    {
      params: { grant_type: "account_credentials", account_id: ZOOM_ACCOUNT_ID },
      headers: { Authorization: `Basic ${basicAuth}` },
      timeout: 15000,
    },
  );

  cachedToken = {
    accessToken: response.data.access_token,
    expiresAt: Date.now() + (response.data.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

/**
 * Zoom's participants report returns one row per join/leave segment (a
 * participant who disconnected and rejoined has multiple rows) - this sums
 * `duration` (seconds) per normalized email across every segment and every
 * page.
 * @param {string} meetingId
 * @returns {Promise<Array<{email: string, durationSeconds: number}>>}
 */
async function getMeetingParticipants(meetingId) {
  const accessToken = await getZoomAccessToken();
  const totalsByEmail = new Map();
  let nextPageToken = "";

  do {
    const response = await axios.get(
      `https://api.zoom.us/v2/report/meetings/${encodeURIComponent(meetingId)}/participants`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { page_size: 300, next_page_token: nextPageToken || undefined },
        timeout: 15000,
      },
    );
    const participants = response.data?.participants || [];
    for (const p of participants) {
      const email = String(p.user_email || "").trim().toLowerCase();
      if (!email) continue; // Zoom participants who never signed in have no email - can't match to a registration
      totalsByEmail.set(email, (totalsByEmail.get(email) || 0) + (p.duration || 0));
    }
    nextPageToken = response.data?.next_page_token || "";
  } while (nextPageToken);

  return Array.from(totalsByEmail.entries()).map(([email, durationSeconds]) => ({ email, durationSeconds }));
}

module.exports = { isConfigured, getZoomAccessToken, getMeetingParticipants };
