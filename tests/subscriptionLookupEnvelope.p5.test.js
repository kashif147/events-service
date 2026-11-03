/**
 * P5 - membership lookup parses subscription-service's REAL response envelope.
 *
 * GET /api/v1/subscriptions/profile/:id/current answers (controllers/subscription.controller.js
 * getSubscriptionsByProfile -> res.success({ data: sub }), middlewares/response.mw.js):
 *   200 { status: "success", data: { data: <current Active subscription | null> } }
 * The old client read `response.data.data` - the inner wrapper object - so EVERY 200 (no subscription,
 * another tenant, a non-existent profile) was "active member", and the category was always null.
 * Fixtures below are that exact envelope.
 */
jest.mock("axios");

let axios;

const P = "6500000000000000000000a1";
const T = "6500000000000000000000f1";

function envelope(sub) {
  return { data: { status: "success", data: { data: sub } } };
}
function activeSub(over = {}) {
  return {
    _id: "6500000000000000000000b1",
    profileId: P,
    tenantId: T,
    isCurrent: true,
    subscriptionStatus: "Active",
    startDate: "2020-01-01T00:00:00.000Z",
    endDate: "2999-12-31T23:59:59.000Z",
    membershipCategory: "undergraduate_student",
    ...over,
  };
}

let client;
beforeEach(() => {
  jest.resetModules();
  process.env.SUBSCRIPTION_SERVICE_URL = "http://subscription-service:4003";
  axios = require("axios");
  axios.get.mockReset();
  client = require("../services/subscriptionLookup.client.js");
});
afterAll(() => {
  delete process.env.SUBSCRIPTION_SERVICE_URL;
});

const NON_MEMBER = { isActiveMember: false, membershipCategory: null };

describe("real envelope", () => {
  test("current Active subscription -> member, category extracted", async () => {
    axios.get.mockResolvedValue(envelope(activeSub()));
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual({
      isActiveMember: true,
      membershipCategory: "undergraduate_student",
    });
  });

  test("no current subscription (data.data null) -> NOT a member", async () => {
    axios.get.mockResolvedValue(envelope(null));
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });

  test("other tenant: subscription-service returns data.data null -> NOT a member", async () => {
    axios.get.mockResolvedValue(envelope(null));
    expect(
      await client.getActiveMembership({ profileId: P, tenantId: "6500000000000000000000f2" }),
    ).toEqual(NON_MEMBER);
  });

  test.each([
    ["a different profile", activeSub({ profileId: "6500000000000000000000a9" })],
    ["a different tenant", activeSub({ tenantId: "6500000000000000000000f9" })],
    ["not current", activeSub({ isCurrent: false })],
    ["not Active", activeSub({ subscriptionStatus: "Cancelled" })],
    ["no profileId", activeSub({ profileId: undefined })],
    // P5 owner proofs: inactive / expired / incomplete rows and cross-tenant rows never establish membership
    ["status Lapsed", activeSub({ subscriptionStatus: "Lapsed" })],
    ["status Suspended", activeSub({ subscriptionStatus: "Suspended" })],
    ["status Resigned", activeSub({ subscriptionStatus: "Resigned" })],
    ["status missing", activeSub({ subscriptionStatus: undefined })],
    ["isCurrent missing", activeSub({ isCurrent: undefined })],
    ["expired (endDate in the past)", activeSub({ endDate: "2001-01-01T00:00:00.000Z" })],
    ["endDate missing", activeSub({ endDate: undefined })],
    ["endDate invalid", activeSub({ endDate: "not-a-date" })],
    ["tenantId missing on the row", activeSub({ tenantId: undefined })],
    ["tenantId null on the row", activeSub({ tenantId: null })],
  ])("subscription for %s -> NOT a member", async (_l, sub) => {
    axios.get.mockResolvedValue(envelope(sub));
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });

  test.each([
    ["the old single-wrapped shape", { data: { data: activeSub() } }],
    ["a list instead of one subscription", { data: { status: "success", data: { data: [activeSub()] } } }],
    ["status fail", { data: { status: "fail", data: { data: activeSub() } } }],
    ["empty body", { data: "" }],
    ["outer wrapper only", { data: { status: "success", data: {} } }],
  ])("%s -> NOT a member", async (_l, response) => {
    axios.get.mockResolvedValue(response);
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });

  test("Active subscription without a category -> member, category null", async () => {
    axios.get.mockResolvedValue(envelope(activeSub({ membershipCategory: undefined })));
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual({
      isActiveMember: true,
      membershipCategory: null,
    });
  });

  test("network / non-2xx error keeps develop behaviour (non-member; fail-closed 503 is a separate change)", async () => {
    axios.get.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500 } }));
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });
});

describe("owner proofs (P5 controlled integration)", () => {
  test("active eligible subscription -> member with its exact category", async () => {
    for (const cat of ["general", "undergraduate_student", "retired"]) {
      axios.get.mockResolvedValue(envelope(activeSub({ membershipCategory: cat })));
      expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual({
        isActiveMember: true,
        membershipCategory: cat,
      });
    }
  });

  test("a 200 alone is never membership: success envelope with an empty object -> NOT a member", async () => {
    axios.get.mockResolvedValue({ status: 200, data: { status: "success", data: { data: {} } } });
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });

  test("endDate exactly now is still active; one ms past is expired", () => {
    const now = new Date("2026-11-03T12:00:00.000Z");
    const body = (end) => ({ status: "success", data: { data: activeSub({ endDate: end }) } });
    expect(client.parseCurrentSubscription(body("2026-11-03T12:00:00.000Z"), { profileId: P, tenantId: T, now })).not.toBeNull();
    expect(client.parseCurrentSubscription(body("2026-11-03T11:59:59.999Z"), { profileId: P, tenantId: T, now })).toBeNull();
  });

  test("cross-tenant: a row for another tenant answered to tenant T never establishes membership", async () => {
    axios.get.mockResolvedValue(envelope(activeSub({ tenantId: "6500000000000000000000f9" })));
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });

  test.each([
    ["timeout", Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" })],
    ["connection refused", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["401 (mixed identity refused)", Object.assign(new Error("401"), { response: { status: 401 } })],
    ["400 TENANT_REQUIRED", Object.assign(new Error("400"), { response: { status: 400 } })],
  ])("service failure (%s) -> fails closed to non-member (develop semantics; #17 turns this into 503)", async (_l, e) => {
    axios.get.mockRejectedValue(e);
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });

  test.each([
    ["non-JSON string body", { status: 200, data: "<html>ok</html>" }],
    ["null body", { status: 200, data: null }],
    ["status success but data is an array", { status: 200, data: { status: "success", data: [activeSub()] } }],
  ])("malformed response (%s) -> NOT a member", async (_l, response) => {
    axios.get.mockResolvedValue(response);
    expect(await client.getActiveMembership({ profileId: P, tenantId: T })).toEqual(NON_MEMBER);
  });
});

describe("SUBSCRIPTION_SERVICE_URL: no fallback host", () => {
  test.each([[undefined], [""], ["   "]])("missing (%p) -> 503 SUBSCRIPTION_SERVICE_URL_REQUIRED, no request", async (v) => {
    if (v === undefined) delete process.env.SUBSCRIPTION_SERVICE_URL;
    else process.env.SUBSCRIPTION_SERVICE_URL = v;
    jest.resetModules();
    axios = require("axios");
    const c = require("../services/subscriptionLookup.client.js");
    await expect(c.getActiveMembership({ profileId: P, tenantId: T })).rejects.toMatchObject({
      status: 503,
      code: "SUBSCRIPTION_SERVICE_URL_REQUIRED",
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("configured -> request goes to that host only (trailing slash trimmed)", async () => {
    process.env.SUBSCRIPTION_SERVICE_URL = "http://subscription-service:4003/";
    axios.get.mockResolvedValue(envelope(null));
    await client.getActiveMembership({ profileId: P, tenantId: T });
    expect(axios.get.mock.calls[0][0]).toBe(
      `http://subscription-service:4003/api/v1/subscriptions/profile/${P}/current`,
    );
  });

  test("the client source holds no hard-coded external host", () => {
    const src = require("fs").readFileSync(require.resolve("../services/subscriptionLookup.client.js"), "utf8");
    expect(src).not.toMatch(/cloudapp\.azure\.com|azurewebsites\.net|https?:\/\/projectshell/i);
  });

  test("no trusted tenant -> no request even when the URL is missing", async () => {
    delete process.env.SUBSCRIPTION_SERVICE_URL;
    jest.resetModules();
    axios = require("axios");
    const c = require("../services/subscriptionLookup.client.js");
    expect(await c.getActiveMembership({ profileId: P, tenantId: "" })).toEqual(NON_MEMBER);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
