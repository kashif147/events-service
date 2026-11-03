// Signed, self-contained check-in passes. A pass is shown by the attendee and SCANNED BY THE
// ORGANISER (POST /registrations/checkin/scan, CRM + events:write) - holding one never records
// attendance by itself (the public redemption route is retired). It is signed (tamper-evident) and
// time-bounded: it expires when the session's QR window closes.
//
// CHECKIN_TOKEN_SECRET is its own dedicated secret and is REQUIRED: there is no fallback to
// JWT_SECRET (a leaked pass must never help attack the auth secret) and no hard-coded default.
// assertCheckinTokenSecret() runs at startup (app.js) so a missing secret fails the boot clearly.
const crypto = require("crypto");

const MIN_SECRET_LENGTH = 32;

function secret() {
  const s = process.env.CHECKIN_TOKEN_SECRET;
  if (typeof s !== "string" || s.length < MIN_SECRET_LENGTH) {
    const err = new Error(`CHECKIN_TOKEN_SECRET is not configured (a dedicated secret of at least ${MIN_SECRET_LENGTH} characters is required)`);
    err.code = "CHECKIN_TOKEN_SECRET_MISSING";
    throw err;
  }
  if (s === process.env.JWT_SECRET) {
    const err = new Error("CHECKIN_TOKEN_SECRET must not equal JWT_SECRET");
    err.code = "CHECKIN_TOKEN_SECRET_REUSED";
    throw err;
  }
  return s;
}

/** Startup check - throws with a clear message (never prints the value). */
function assertCheckinTokenSecret() {
  secret();
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

/**
 * @param {{tenantId: string, registrationId: string, sessionId: string, expiresAt: Date|number}} params
 * @returns {string} opaque token, safe to embed in a QR code
 */
function signCheckinToken({ tenantId, registrationId, sessionId, expiresAt }) {
  const exp = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
  if (!Number.isFinite(exp)) throw new Error("signCheckinToken: expiresAt is required");
  const payload = { v: 2, kind: "checkin", tenantId, registrationId, sessionId, exp };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Accepts v2 passes and legacy (pre-P5, 24 h, signed with the same dedicated secret) passes; the
 * scan route re-checks the window either way.
 * @returns {{tenantId: string, registrationId: string, sessionId: string}|null} null if invalid/expired/tampered
 */
function verifyCheckinToken(token) {
  if (typeof token !== "string" || token.length > 2048 || !token.includes(".")) return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  const expectedBuf = Buffer.from(sign(payloadB64));
  const sigBuf = Buffer.from(signature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.v !== undefined && (payload.v !== 2 || payload.kind !== "checkin")) return null;
  if (!payload?.tenantId || !payload?.registrationId || !payload?.sessionId) return null;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;

  return { tenantId: payload.tenantId, registrationId: payload.registrationId, sessionId: payload.sessionId };
}

module.exports = { signCheckinToken, verifyCheckinToken, assertCheckinTokenSecret, MIN_SECRET_LENGTH };
