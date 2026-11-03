/**
 * P5 (subscription #30 prerequisite) - the membership lookup to subscription-service is a genuine
 * internal call: x-internal-request + the verified tenant, never the caller's identity. And the
 * price quote, which returns isActiveMember/membershipCategory, is computed only for a profile
 * the caller may know about (CRM: ?profileId; PORTAL: own profile; anything else: non-member).
 */
process.env.AUTH_BYPASS_ENABLED = "false";
process.env.SUBSCRIPTION_SERVICE_URL = "http://subscription-service:4003";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("axios");
jest.mock("../middlewares/policy.middleware.js", () => require("./helpers/pdpMock.js").createPdpMock());
jest.mock("../services/profileLookup.client.js");
jest.mock("../services/lookup.client.js");

const axios = require("axios");
const { getCallerOwnProfile } = require("../services/profileLookup.client.js");
const { getActiveMembership, buildHeaders } = require("../services/subscriptionLookup.client.js");
const app = require("../app");
const Event = require("../models/event.model.js");

const TENANT = "tenant-p5-mixedid-a";
const IDENTITY_HEADERS = [
  "authorization",
  "x-jwt-verified",
  "x-auth-source",
  "x-gateway-signature",
  "x-token-expires-at",
  "x-user-id",
  "x-user-email",
  "x-user-type",
  "x-user-roles",
  "x-user-permissions",
];

function assertInternalOnly(headers, tenantId) {
  expect(headers["x-internal-request"]).toBe("true");
  expect(headers["x-tenant-id"]).toBe(tenantId);
  const sent = Object.keys(headers).map((k) => k.toLowerCase());
  for (const name of IDENTITY_HEADERS) expect(sent).not.toContain(name);
}

const callerReq = {
  headers: {
    authorization: "Bearer caller-token",
    "x-jwt-verified": "true",
    "x-auth-source": "gateway",
    "x-user-id": "u-1",
    "x-user-type": "CRM",
    "x-user-permissions": "[\"*\"]",
  },
};

beforeEach(() => {
  axios.get.mockReset();
  // subscription-service's real envelope: { status, data: { data: <current subscription> } }, scoped to
  // the requested profile and tenant.
  axios.get.mockImplementation(async (url, opts) => {
    const profileId = url.match(/\/profile\/([^/]+)\/current$/)[1];
    return {
      data: {
        status: "success",
        data: {
          data: {
            _id: "sub-1",
            profileId,
            tenantId: opts.headers["x-tenant-id"],
            isCurrent: true,
            subscriptionStatus: "Active",
            membershipCategory: "general",
          },
        },
      },
    };
  });
  getCallerOwnProfile.mockReset();
});

describe("subscriptionLookup.getActiveMembership headers", () => {
  test("sends internal + verified tenant and no caller identity, even when a request is passed", async () => {
    const out = await getActiveMembership({ profileId: "p-1", tenantId: TENANT, req: callerReq });
    expect(out).toEqual({ isActiveMember: true, membershipCategory: "general" });
    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/subscriptions\/profile\/p-1\/current$/);
    assertInternalOnly(opts.headers, TENANT);
  });

  test("buildHeaders never carries identity", () => {
    assertInternalOnly(buildHeaders(TENANT), TENANT);
  });

  test.each([[undefined], [null], [""], ["  "]])("no trusted tenant (%p): no call, non-member", async (tenantId) => {
    expect(await getActiveMembership({ profileId: "p-1", tenantId, req: callerReq })).toEqual({
      isActiveMember: false,
      membershipCategory: null,
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("no profileId: no call, non-member", async () => {
    expect(await getActiveMembership({ profileId: null, tenantId: TENANT })).toEqual({
      isActiveMember: false,
      membershipCategory: null,
    });
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe("GET /api/events/:id/price-quote membership subject", () => {
  let event;
  const bearer = (claims) => `Bearer ${jwt.sign({ tenantId: TENANT, roles: [], ...claims }, process.env.JWT_SECRET)}`;
  const quote = (auth, profileId) =>
    request(app)
      .get(`/api/events/${event._id}/price-quote${profileId ? `?profileId=${profileId}` : ""}`)
      .set("Authorization", auth);
  const lookedUp = () => axios.get.mock.calls.map(([url]) => url.match(/profile\/([^/]+)\/current/)[1]);

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);
  });
  beforeEach(async () => {
    event = await Event.create({
      tenantId: TENANT,
      title: "Quote event",
      startDate: new Date("2030-01-01T09:00:00Z"),
      endDate: new Date("2030-01-01T17:00:00Z"),
      status: "Published",
      memberPrice: 50,
      nonMemberPrice: 80,
      createdBy: "64b000000000000000000c01",
    });
  });
  afterEach(async () => {
    await Event.deleteMany({ tenantId: TENANT });
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  test("CRM: quoted for the requested attendee profile, internal-only headers", async () => {
    const res = await quote(bearer({ sub: "crm-1", userType: "CRM" }), "profile-b");
    expect(res.status).toBe(200);
    expect(res.body.data.isActiveMember).toBe(true);
    expect(lookedUp()).toEqual(["profile-b"]);
    assertInternalOnly(axios.get.mock.calls[0][1].headers, TENANT);
    expect(getCallerOwnProfile).not.toHaveBeenCalled();
  });

  test("PORTAL: another member's profileId is ignored; quoted for the caller's own profile", async () => {
    getCallerOwnProfile.mockResolvedValue({ profileId: "profile-a", membershipNumber: "M1" });
    const res = await quote(bearer({ sub: "portal-a", userType: "PORTAL" }), "profile-b");
    expect(res.status).toBe(200);
    expect(lookedUp()).toEqual(["profile-a"]);
    assertInternalOnly(axios.get.mock.calls[0][1].headers, TENANT);
  });

  test("PORTAL without a bound profile: non-member quote, no subscription lookup", async () => {
    getCallerOwnProfile.mockResolvedValue(null);
    const res = await quote(bearer({ sub: "portal-a", userType: "PORTAL" }), "profile-b");
    expect(res.status).toBe(200);
    expect(res.body.data.isActiveMember).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("PORTAL own-profile lookup failure fails closed (503), nothing disclosed", async () => {
    getCallerOwnProfile.mockRejectedValue(new Error("profile-service down"));
    const res = await quote(bearer({ sub: "portal-a", userType: "PORTAL" }), "profile-b");
    expect(res.status).toBe(503);
    expect(res.body.data).toBeUndefined();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test("unknown caller type: quoted as a non-member, the supplied profileId is never looked up", async () => {
    const res = await quote(bearer({ sub: "x-1", userType: "SOMETHING" }), "profile-b");
    expect(res.status).toBe(200);
    expect(res.body.data.isActiveMember).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
