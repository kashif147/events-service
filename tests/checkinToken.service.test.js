const { signCheckinToken, verifyCheckinToken } = require("../services/checkinToken.service.js");

describe("checkinToken.service", () => {
  const params = { tenantId: "tenant-1", registrationId: "reg-1", sessionId: "session-1" };

  it("round-trips a signed token", () => {
    const token = signCheckinToken(params);
    expect(verifyCheckinToken(token)).toEqual(params);
  });

  it("rejects a tampered payload", () => {
    const token = signCheckinToken(params);
    const [payloadB64, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...params, registrationId: "reg-2", exp: Date.now() + 60000 }),
    ).toString("base64url");
    expect(verifyCheckinToken(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signCheckinToken(params);
    const [payloadB64] = token.split(".");
    expect(verifyCheckinToken(`${payloadB64}.not-a-real-signature`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signCheckinToken({ ...params, expiresInMs: -1000 });
    expect(verifyCheckinToken(token)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifyCheckinToken("not-a-token")).toBeNull();
    expect(verifyCheckinToken("")).toBeNull();
    expect(verifyCheckinToken(null)).toBeNull();
  });
});
