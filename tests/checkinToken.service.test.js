const { signCheckinToken, verifyCheckinToken, assertCheckinTokenSecret } = require("../services/checkinToken.service.js");

describe("checkinToken.service", () => {
  const params = { tenantId: "tenant-1", registrationId: "reg-1", sessionId: "session-1" };
  const inAnHour = () => Date.now() + 3600000;

  it("round-trips a signed token", () => {
    const token = signCheckinToken({ ...params, expiresAt: inAnHour() });
    expect(verifyCheckinToken(token)).toEqual(params);
  });

  it("requires an explicit expiry", () => {
    expect(() => signCheckinToken(params)).toThrow(/expiresAt/);
  });

  it("rejects a tampered payload", () => {
    const token = signCheckinToken({ ...params, expiresAt: inAnHour() });
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ v: 2, kind: "checkin", ...params, registrationId: "reg-2", exp: inAnHour() }),
    ).toString("base64url");
    expect(verifyCheckinToken(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signCheckinToken({ ...params, expiresAt: inAnHour() });
    const [payloadB64] = token.split(".");
    expect(verifyCheckinToken(`${payloadB64}.not-a-real-signature`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signCheckinToken({ ...params, expiresAt: Date.now() - 1000 });
    expect(verifyCheckinToken(token)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifyCheckinToken("not-a-token")).toBeNull();
    expect(verifyCheckinToken("")).toBeNull();
    expect(verifyCheckinToken(null)).toBeNull();
  });

  describe("dedicated secret (no fallback)", () => {
    const saved = { c: process.env.CHECKIN_TOKEN_SECRET, j: process.env.JWT_SECRET };
    afterEach(() => {
      process.env.CHECKIN_TOKEN_SECRET = saved.c;
      process.env.JWT_SECRET = saved.j;
    });

    it("missing CHECKIN_TOKEN_SECRET fails clearly (no JWT_SECRET / hard-coded fallback)", () => {
      delete process.env.CHECKIN_TOKEN_SECRET;
      expect(() => assertCheckinTokenSecret()).toThrow(/CHECKIN_TOKEN_SECRET is not configured/);
      expect(() => signCheckinToken({ ...params, expiresAt: inAnHour() })).toThrow(/CHECKIN_TOKEN_SECRET/);
      expect(() => verifyCheckinToken("a.b")).toThrow(/CHECKIN_TOKEN_SECRET/);
    });

    it("a short secret is refused", () => {
      process.env.CHECKIN_TOKEN_SECRET = "short";
      expect(() => assertCheckinTokenSecret()).toThrow(/at least 32/);
    });

    it("reusing JWT_SECRET is refused", () => {
      process.env.CHECKIN_TOKEN_SECRET = "x".repeat(40);
      process.env.JWT_SECRET = "x".repeat(40);
      expect(() => assertCheckinTokenSecret()).toThrow(/must not equal JWT_SECRET/);
    });

    it("the error message never contains the configured value", () => {
      process.env.CHECKIN_TOKEN_SECRET = "SENTINEL-short";
      try {
        assertCheckinTokenSecret();
      } catch (e) {
        expect(e.message).not.toContain("SENTINEL");
      }
    });

    it("a pass signed with another secret does not verify", () => {
      process.env.CHECKIN_TOKEN_SECRET = "a".repeat(40);
      const token = signCheckinToken({ ...params, expiresAt: inAnHour() });
      process.env.CHECKIN_TOKEN_SECRET = "b".repeat(40);
      expect(verifyCheckinToken(token)).toBeNull();
    });

    it("a legacy (pre-P5, unversioned) pass signed with the same dedicated secret still verifies", () => {
      const crypto = require("crypto");
      const payloadB64 = Buffer.from(JSON.stringify({ ...params, exp: inAnHour() })).toString("base64url");
      const sig = crypto.createHmac("sha256", process.env.CHECKIN_TOKEN_SECRET).update(payloadB64).digest("base64url");
      expect(verifyCheckinToken(`${payloadB64}.${sig}`)).toEqual(params);
    });
  });
});
