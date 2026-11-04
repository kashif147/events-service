/**
 * P5 S3 signed service authority - signer side (protocol "p5-svc-sig" version 1).
 *
 * events-service signs each bound payment command it sends to account-service with ITS OWN
 * credential (never JWT_SECRET, never another service's key). account-service verifies it
 * (account-service src/lib/serviceSigning.js + middlewares/serviceAuth.middleware.js). This is a
 * local copy of the same algorithm (no cross-service import); contracts/p5-service-signing.v1.json
 * is byte-identical in account-service, events-service and profile-service and pinned by SHA-256 in
 * each test suite.
 *
 * Canonical string: "p5-svc-sig/1" then one length-prefixed field per line, fixed order:
 *   aud, caller, kid, method (uppercase), target (exact path + raw query as sent), tenant,
 *   idem (Idempotency-Key), body (hex sha256 of the exact transmitted bytes), ts, nonce
 * each as `<name>=<utf8 byte length>:<value>`, joined with "\n". sig = base64url(HMAC-SHA256).
 *
 * Config (this service's own env file only): ACCOUNT_SIGNING_KID, ACCOUNT_SIGNING_SECRET.
 * Not configured -> no signature headers (rollout R0); one warning per process:
 *   [svc-sign] account command signing not configured; sending unsigned caller=<this service>
 * Configured but invalid -> fail closed; each refusal logs (reason only, never a value):
 *   [svc-sign] account command signing misconfigured caller=<this service> reason=kid_format|secret_length
 * A retry of the same business command signs again with a fresh nonce and the same
 * Idempotency-Key. Never logs the secret, signature or payload.
 */
const crypto = require("crypto");
const { AppError } = require("../errors/AppError.js");

const PROTOCOL = "p5-svc-sig";
const VERSION = "1";
const AUDIENCE = "account-service";
const CALLER = "events-service";
const MIN_SECRET_LENGTH = 32;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes || Buffer.alloc(0)).digest("hex");
}

function field(name, value) {
  const v = value == null ? "" : String(value);
  return `${name}=${Buffer.byteLength(v, "utf8")}:${v}`;
}

function canonicalString({ caller, kid, method, target, tenant, idem, bodySha256, ts, nonce, aud = AUDIENCE }) {
  return [
    `${PROTOCOL}/${VERSION}`,
    field("aud", aud),
    field("caller", caller),
    field("kid", kid),
    field("method", String(method || "").toUpperCase()),
    field("target", target),
    field("tenant", tenant),
    field("idem", idem),
    field("body", bodySha256),
    field("ts", ts),
    field("nonce", nonce),
  ].join("\n");
}

function signCanonical(secret, canonical) {
  return crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("base64url");
}

let warnedUnconfigured = false;
/** Test hook: re-arm the once-per-process "not configured" warning. */
function resetUnconfiguredWarning() {
  warnedUnconfigured = false;
}

/** Returns { kid, secret } or null when signing is not configured; throws when misconfigured. */
function signingConfig(env = process.env) {
  const kid = String(env.ACCOUNT_SIGNING_KID || "").trim();
  const secret = String(env.ACCOUNT_SIGNING_SECRET || "");
  if (!kid && !secret) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(`[svc-sign] account command signing not configured; sending unsigned caller=${CALLER}`);
    }
    return null;
  }
  if (!KID_RE.test(kid) || secret.length < MIN_SECRET_LENGTH) {
    const reason = !KID_RE.test(kid) ? "kid_format" : "secret_length";
    console.error(`[svc-sign] account command signing misconfigured caller=${CALLER} reason=${reason}`);
    throw new AppError("Account command signing is misconfigured.", 503, "ACCOUNT_SIGNING_MISCONFIGURED");
  }
  return { kid, secret };
}

/** Exact path + raw query string of the URL actually requested. */
function targetOf(url) {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/**
 * Signature headers for one request, or {} when signing is not configured.
 * `raw` must be the exact body string that goes on the wire.
 */
function signatureHeaders({ method, url, tenant, idem, raw, env = process.env, now = Date.now(), nonce }) {
  const cfg = signingConfig(env);
  if (!cfg) return {};
  const ts = String(Math.floor(now / 1000));
  const nonceV = nonce || crypto.randomBytes(18).toString("base64url");
  const canonical = canonicalString({
    caller: CALLER,
    kid: cfg.kid,
    method,
    target: targetOf(url),
    tenant,
    idem,
    bodySha256: sha256Hex(Buffer.from(raw, "utf8")),
    ts,
    nonce: nonceV,
  });
  return {
    "x-svc-version": VERSION,
    "x-svc-caller": CALLER,
    "x-svc-kid": cfg.kid,
    "x-svc-ts": ts,
    "x-svc-nonce": nonceV,
    "x-svc-sig": signCanonical(cfg.secret, canonical),
  };
}

module.exports = {
  PROTOCOL,
  VERSION,
  AUDIENCE,
  CALLER,
  sha256Hex,
  canonicalString,
  signCanonical,
  signingConfig,
  signatureHeaders,
  resetUnconfiguredWarning,
  targetOf,
};
