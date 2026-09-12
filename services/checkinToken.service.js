// Signed, self-contained tokens for QR/in-person self-check-in - the token
// itself is the credential (no gateway JWT/login required to scan it), so it
// must be signed (tamper-evident) and time-bounded (can't be replayed
// forever). CHECKIN_TOKEN_SECRET is its own dedicated secret - deliberately
// not named *_API_KEY (see the root architecture-boundaries.md hard rule) and
// not reusing JWT_SECRET (a leaked check-in QR must never be usable to derive
// or attack the real auth secret).
const crypto = require("crypto");

const SECRET = process.env.CHECKIN_TOKEN_SECRET || process.env.JWT_SECRET || "events-service-checkin-secret";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}

/**
 * @param {{tenantId: string, registrationId: string, sessionId: string, expiresInMs?: number}} params
 * @returns {string} opaque token, safe to embed in a URL/QR code
 */
function signCheckinToken({ tenantId, registrationId, sessionId, expiresInMs = 24 * 60 * 60 * 1000 }) {
  const payload = { tenantId, registrationId, sessionId, exp: Date.now() + expiresInMs };
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = sign(payloadB64);
  return `${payloadB64}.${signature}`;
}

/**
 * @param {string} token
 * @returns {{tenantId: string, registrationId: string, sessionId: string}|null} null if invalid/expired/tampered
 */
function verifyCheckinToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;

  const expectedSignature = sign(payloadB64);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload?.tenantId || !payload?.registrationId || !payload?.sessionId) return null;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;

  return { tenantId: payload.tenantId, registrationId: payload.registrationId, sessionId: payload.sessionId };
}

module.exports = { signCheckinToken, verifyCheckinToken };
