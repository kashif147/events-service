/**
 * P5 STUDENT policy: a failed membership lookup is never "non-member".
 * services/subscriptionLookup.client.js getActiveMembership throws a 503
 * MEMBERSHIP_LOOKUP_FAILED on any transport / non-2xx failure; a successful
 * lookup with no current subscription is still non-member.
 */
jest.mock("axios");
const axios = require("axios");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");

const args = { profileId: "64c0000000000000000000f1", tenantId: "64c0000000000000000000a1", req: { headers: {} } };

let errSpy;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUBSCRIPTION_SERVICE_URL = "http://subscription-service:4003";
  errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

test.each([
  ["network error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })],
  ["timeout", Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" })],
  ["upstream 500", Object.assign(new Error("Request failed with status code 500"), { response: { status: 500 } })],
  ["upstream 403", Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } })],
])("%s -> rejects with 503 MEMBERSHIP_LOOKUP_FAILED", async (_l, error) => {
  axios.get.mockRejectedValue(error);
  await expect(getActiveMembership(args)).rejects.toMatchObject({ status: 503, code: "MEMBERSHIP_LOOKUP_FAILED" });
});

test("successful lookup with no current subscription -> non-member", async () => {
  // subscription-service's real envelope: { status, data: { data: <sub|null> } }
  axios.get.mockResolvedValue({ data: { status: "success", data: { data: null } } });
  await expect(getActiveMembership(args)).resolves.toEqual({ isActiveMember: false, membershipCategory: null });
});

test("successful lookup with a current subscription -> member with its category", async () => {
  axios.get.mockResolvedValue({
    data: {
      status: "success",
      data: {
        data: {
          profileId: args.profileId,
          tenantId: args.tenantId,
          isCurrent: true,
          subscriptionStatus: "Active",
          endDate: "2999-12-31T23:59:59.000Z",
          membershipCategory: "Undergraduate Student",
        },
      },
    },
  });
  await expect(getActiveMembership(args)).resolves.toEqual({ isActiveMember: true, membershipCategory: "Undergraduate Student" });
});

test("missing SUBSCRIPTION_SERVICE_URL -> 503 SUBSCRIPTION_SERVICE_URL_REQUIRED, no call", async () => {
  delete process.env.SUBSCRIPTION_SERVICE_URL;
  await expect(getActiveMembership(args)).rejects.toMatchObject({ status: 503, code: "SUBSCRIPTION_SERVICE_URL_REQUIRED" });
  expect(axios.get).not.toHaveBeenCalled();
});

test("no profile to look up -> non-member without a call", async () => {
  await expect(getActiveMembership({ ...args, profileId: null })).resolves.toEqual({ isActiveMember: false, membershipCategory: null });
  expect(axios.get).not.toHaveBeenCalled();
});
