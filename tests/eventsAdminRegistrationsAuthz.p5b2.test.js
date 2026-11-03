/**
 * P5 batch 2 - event administration is CRM-only; portal self-service
 * registration routes move onto registrations:<action> (with the temporary
 * legacy events:<action> fallback); createRegistration identity and tier
 * eligibility are derived from the verified caller.
 *
 * PDP is mocked (tests/helpers/pdpMock.js). CRM/staff routes: the policy
 * middleware mock, driven by x-test-pdp / x-test-pdp-deny headers. PORTAL
 * registration routes: the direct policy-client evaluation, driven by the
 * test token's pdpDeny / pdpReason / pdpError claims. AUTH_BYPASS_ENABLED is
 * switched off here so evaluatePermission really consults the (mocked)
 * policy client instead of the local bypass.
 */
process.env.AUTH_BYPASS_ENABLED = "false";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => require("./helpers/pdpMock.js").createPdpMock());
jest.mock("../services/accountService.client.js");
jest.mock("../services/profileLookup.client.js");
jest.mock("../services/subscriptionLookup.client.js");
jest.mock("../services/lookup.client.js");
jest.mock("../services/certificateIssuance.service.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");

const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const {
  postManualRegistrationPayment,
  createRegistrationPaymentIntent,
} = require("../services/accountService.client.js");
const {
  getCallerOwnProfile,
  checkAttendeeDuplicates,
  getProfileMembershipNumber,
} = require("../services/profileLookup.client.js");
const { getActiveMembership } = require("../services/subscriptionLookup.client.js");
const { resolveLookupNamesByIds } = require("../services/lookup.client.js");
const { createCertificateForRegistration } = require("../services/certificateIssuance.service.js");

const app = require("../app");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const { TZ, sessionTiming } = require("./helpers/attendanceTiming.js");
const Course = require("../models/course.model.js");
const Registration = require("../models/registration.model.js");
const Template = require("../models/template.model.js");
const {
  requireRegistrationPermission,
  evaluatePermission,
  LEGACY_FALLBACK_ABSENT_REASONS,
} = require("../middlewares/registrationPermission.mw.js");

const TENANT = "tenant-p5b2-a";
const OTHER_TENANT = "tenant-p5b2-c";
const USER_A = "p5b2-portal-a";
const USER_B = "p5b2-portal-b";
const USER_C = "p5b2-portal-c";
const CRM_USER = "64b000000000000000000c01"; // Template.userId is an ObjectId

function bearer({ sub, tenantId = TENANT, userType, pdpDeny, pdpReason, pdpError }) {
  const claims = { sub, tenantId, roles: [] };
  if (userType !== undefined) claims.userType = userType;
  if (pdpDeny) claims.pdpDeny = pdpDeny;
  if (pdpReason) claims.pdpReason = pdpReason;
  if (pdpError) claims.pdpError = true;
  return `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}`;
}
const portalA = (pdp = {}) => bearer({ sub: USER_A, userType: "PORTAL", ...pdp });
const portalC = () => bearer({ sub: USER_C, tenantId: OTHER_TENANT, userType: "PORTAL" });
const crm = () => bearer({ sub: CRM_USER, userType: "CRM" });
const noType = () => bearer({ sub: USER_A });
const unknownType = () => bearer({ sub: USER_A, userType: "SOMETHING" });

function send(method, path, auth, { body, headers = {} } = {}) {
  let req = request(app)[method](path).set("Authorization", auth);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return body ? req.send(body) : req;
}

let event;
let eventC;
let session;
let course;
let courseC;
let template;
let regA;
let regB;
let regC;
let counter = 0;

function makeRegistration(overrides = {}) {
  counter += 1;
  const email = `p5b2-${counter}@example.test`;
  return Registration.create({
    tenantId: TENANT,
    registrationType: "event",
    eventId: event._id,
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 5000,
    currency: "eur",
    paymentMethod: "manual",
    paymentStatus: "pending",
    status: "pending",
    approvalStatus: "pending_review",
    registeredVia: "portal",
    isActive: true,
    ...overrides,
  });
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

beforeEach(async () => {
  const base = {
    title: "Original title",
    startDate: new Date("2030-01-01T09:00:00Z"),
    endDate: new Date("2030-01-01T17:00:00Z"),
    status: "Published",
    timezone: TZ,
    memberPrice: 50,
    nonMemberPrice: 80,
    createdBy: CRM_USER,
  };
  event = await Event.create({ tenantId: TENANT, ...base });
  eventC = await Event.create({ tenantId: OTHER_TENANT, ...base });
  session = await EventSession.create({ tenantId: TENANT, eventId: event._id, label: "Day 1", date: new Date(), isVirtual: true, ...sessionTiming() });
  course = await Course.create({ tenantId: TENANT, title: "Original course", startDate: new Date("2030-02-01") });
  courseC = await Course.create({ tenantId: OTHER_TENANT, title: "Original course", startDate: new Date("2030-02-01") });
  template = await Template.create({
    tenantId: TENANT,
    userId: CRM_USER,
    name: "My view",
    templateType: "eventssummary",
  });
  regA = await makeRegistration({ submittedByUserId: USER_A });
  regB = await makeRegistration({ submittedByUserId: USER_B });
  regC = await makeRegistration({ tenantId: OTHER_TENANT, eventId: eventC._id, submittedByUserId: USER_C });

  resolveLookupNamesByIds.mockResolvedValue(new Map());
  getActiveMembership.mockResolvedValue({ isActiveMember: false, membershipCategory: null });
  getCallerOwnProfile.mockResolvedValue(null);
  checkAttendeeDuplicates.mockResolvedValue({ resolution: "none" });
  getProfileMembershipNumber.mockResolvedValue(null);
  postManualRegistrationPayment.mockResolvedValue({ paymentId: "payment-manual-1" });
  createRegistrationPaymentIntent.mockResolvedValue({
    paymentId: "payment-stripe-1",
    paymentIntentId: "pi_test_1",
    clientSecret: "pi_test_1_secret",
  });
  createCertificateForRegistration.mockResolvedValue({ id: "cert-1" });
});

afterEach(async () => {
  const tenants = { $in: [TENANT, OTHER_TENANT] };
  await Promise.all([
    Event.deleteMany({ tenantId: tenants }),
    EventSession.deleteMany({ tenantId: tenants }),
    Course.deleteMany({ tenantId: tenants }),
    Registration.deleteMany({ tenantId: tenants }),
    Template.deleteMany({ tenantId: tenants }),
  ]);
  defaultPolicyMiddleware.calls.length = 0;
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

async function expectAdminStateUntouched() {
  const [ev, sess, crs, tpl] = await Promise.all([
    Event.findById(event._id).lean(),
    EventSession.findById(session._id).lean(),
    Course.findById(course._id).lean(),
    Template.findById(template._id).lean(),
  ]);
  expect(ev.title).toBe("Original title");
  expect(ev.status).toBe("Published");
  expect(ev.isDeleted).not.toBe(true);
  expect(sess.label).toBe("Day 1");
  expect(sess.isDeleted).not.toBe(true);
  expect(crs.title).toBe("Original course");
  expect(crs.isDeleted).not.toBe(true);
  expect(tpl.name).toBe("My view");
  expect(await Event.countDocuments({ tenantId: TENANT })).toBe(1);
  expect(await Course.countDocuments({ tenantId: TENANT })).toBe(1);
  expect(await Template.countDocuments({ tenantId: TENANT })).toBe(1);
  expect(await EventSession.countDocuments({ tenantId: TENANT })).toBe(1);
}

// ---------------------------------------------------------------------------
// 1. Event administration: CRM caller + events:create/write; portal 403
//    CRM_ONLY whatever it holds.
// ---------------------------------------------------------------------------
const adminRoutes = [
  { name: "POST /events", method: "post", path: () => "/api/events", perm: "events:create",
    body: { title: "Injected", startDate: "2030-01-01", endDate: "2030-01-02" } },
  { name: "PUT /events/:id", method: "put", path: () => `/api/events/${event._id}`, perm: "events:write",
    body: { title: "Hacked" } },
  { name: "DELETE /events/:id", method: "delete", path: () => `/api/events/${event._id}`, perm: "events:write" },
  { name: "PUT /events/:id/unpublish", method: "put", path: () => `/api/events/${event._id}/unpublish`, perm: "events:write" },
  { name: "PUT /events/:id/cancel", method: "put", path: () => `/api/events/${event._id}/cancel`, perm: "events:write" },
  { name: "PUT /events/:id/complete", method: "put", path: () => `/api/events/${event._id}/complete`, perm: "events:write" },
  { name: "POST /events/:id/image", method: "post", path: () => `/api/events/${event._id}/image`, perm: "events:create" },
  { name: "POST /events/:id/sessions", method: "post", path: () => `/api/events/${event._id}/sessions`, perm: "events:create",
    body: { label: "Injected day", date: "2030-01-01" } },
  { name: "PUT /events/:id/sessions/:sessionId", method: "put", path: () => `/api/events/${event._id}/sessions/${session._id}`,
    perm: "events:write", body: { label: "Hacked day" } },
  { name: "DELETE /events/:id/sessions/:sessionId", method: "delete",
    path: () => `/api/events/${event._id}/sessions/${session._id}`, perm: "events:write" },
  { name: "POST /courses", method: "post", path: () => "/api/courses", perm: "events:create",
    body: { title: "Injected course", startDate: "2030-01-01" } },
  { name: "PUT /courses/:id", method: "put", path: () => `/api/courses/${course._id}`, perm: "events:write",
    body: { title: "Hacked course" } },
  { name: "DELETE /courses/:id", method: "delete", path: () => `/api/courses/${course._id}`, perm: "events:write" },
  { name: "POST /templates", method: "post", path: () => "/api/templates", perm: "events:write",
    body: { name: "Injected view", templateType: "eventssummary" } },
  { name: "PUT /templates/:id", method: "put", path: () => `/api/templates/${template._id}`, perm: "events:write",
    body: { name: "Hacked view" } },
  { name: "DELETE /templates/:id", method: "delete", path: () => `/api/templates/${template._id}`, perm: "events:write" },
  { name: "GET /templates", method: "get", path: () => "/api/templates", perm: "events:read" },
  { name: "GET /templates/default", method: "get", path: () => "/api/templates/default", perm: "events:read" },
  { name: "GET /templates/:id", method: "get", path: () => `/api/templates/${template._id}`, perm: "events:read" },
  { name: "POST /certificates/:registrationId/issue", method: "post",
    path: () => `/api/certificates/${regA._id}/issue`, perm: "events:create", body: { templateId: "tpl-1" } },
];

describe.each(adminRoutes)("admin $name", (route) => {
  it("PORTAL (holding every permission per mocked PDP) -> 403 CRM_ONLY, nothing changed, PDP never consulted", async () => {
    const res = await send(route.method, route.path(), portalA(), { body: route.body });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    expect(defaultPolicyMiddleware.calls).toEqual([]);
    await expectAdminStateUntouched();
    expect(createCertificateForRegistration).not.toHaveBeenCalled();
  });

  it("PORTAL of another tenant -> 403 CRM_ONLY", async () => {
    const res = await send(route.method, route.path(), portalC(), { body: route.body });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    await expectAdminStateUntouched();
  });

  it("missing userType -> 403 CRM_ONLY (fail closed)", async () => {
    const res = await send(route.method, route.path(), noType(), { body: route.body });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    await expectAdminStateUntouched();
  });

  it("unknown userType -> 403 CRM_ONLY", async () => {
    const res = await send(route.method, route.path(), unknownType(), { body: route.body });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    await expectAdminStateUntouched();
  });

  it("CRM without the permission -> 403 PERMISSION_DENIED, nothing changed", async () => {
    const res = await send(route.method, route.path(), crm(), {
      body: route.body,
      headers: { "x-test-pdp-deny": route.perm },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
    expect(defaultPolicyMiddleware.calls).toEqual([route.perm]);
    await expectAdminStateUntouched();
  });

  it("CRM + permission reaches the handler (the explicit permission is the one checked)", async () => {
    const res = await send(route.method, route.path(), crm(), { body: route.body });
    expect(defaultPolicyMiddleware.calls).toEqual([route.perm]);
    expect([401, 403]).not.toContain(res.status);
  });
});

describe("admin routes: CRM + permission effects, tenant-scoped", () => {
  it("PUT /events/:id updates the tenant's event", async () => {
    const res = await send("put", `/api/events/${event._id}`, crm(), { body: { description: "Updated" } });
    expect(res.status).toBe(200);
    expect((await Event.findById(event._id).lean()).description).toBe("Updated");
  });

  it("PUT /events/:id on another tenant's event -> 404, untouched", async () => {
    const res = await send("put", `/api/events/${eventC._id}`, crm(), { body: { title: "Renamed" } });
    expect(res.status).toBe(404);
    expect((await Event.findById(eventC._id).lean()).title).toBe("Original title");
  });

  it("DELETE /events/:id on another tenant's event -> 404, untouched", async () => {
    const res = await send("delete", `/api/events/${eventC._id}`, crm());
    expect(res.status).toBe(404);
    expect((await Event.findById(eventC._id).lean()).isDeleted).not.toBe(true);
  });

  it("PUT /courses/:id on another tenant's course -> 404, untouched", async () => {
    const res = await send("put", `/api/courses/${courseC._id}`, crm(), { body: { title: "Renamed" } });
    expect(res.status).toBe(404);
    expect((await Course.findById(courseC._id).lean()).title).toBe("Original course");
  });

  it("POST /courses creates in the caller's tenant", async () => {
    const res = await send("post", "/api/courses", crm(), { body: { title: "New course", startDate: "2030-03-01" } });
    expect(res.status).toBe(201);
    expect(await Course.countDocuments({ tenantId: TENANT, title: "New course" })).toBe(1);
  });

  it("POST /events/:id/sessions adds a session (published event: audited, reason required)", async () => {
    const noReason = await send("post", `/api/events/${event._id}/sessions`, crm(), {
      body: { label: "Day 2", date: "2030-01-02" },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("SCHEDULE_CHANGE_REASON_REQUIRED");
    const res = await send("post", `/api/events/${event._id}/sessions`, crm(), {
      body: { label: "Day 2", date: "2030-01-02", scheduleChangeReason: "Second day added" },
    });
    expect(res.status).toBe(201);
  });

  it("POST /certificates/:registrationId/issue on another tenant's registration -> 404", async () => {
    const res = await send("post", `/api/certificates/${regC._id}/issue`, crm(), { body: { templateId: "tpl-1" } });
    expect(res.status).toBe(404);
    expect(createCertificateForRegistration).not.toHaveBeenCalled();
  });

  it("POST /certificates/:registrationId/issue on own tenant -> 201", async () => {
    const res = await send("post", `/api/certificates/${regA._id}/issue`, crm(), { body: { templateId: "tpl-1" } });
    expect(res.status).toBe(201);
    expect(createCertificateForRegistration).toHaveBeenCalledTimes(1);
  });

  it("POST /events/:id/image rejects a crafted (non-ObjectId) id before touching storage", async () => {
    const res = await request(app)
      .post("/api/events/..%2F..%2Fother-tenant/image")
      .set("Authorization", crm())
      .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: "x.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Invalid event id");
  });

  it("read routes stay as they are: PORTAL may still GET events / courses / price-quote", async () => {
    for (const path of ["/api/events", `/api/events/${event._id}`, "/api/courses", `/api/courses/${course._id}`]) {
      const res = await send("get", path, portalA());
      expect(res.status).toBe(200);
    }
    expect(defaultPolicyMiddleware.calls.every((c) => c === "events:read")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Portal self-service registration routes -> registrations:<action>,
//    legacy events:<action> fallback during transition; CRM keeps events:*.
// ---------------------------------------------------------------------------
const selfRoutes = [
  { name: "GET /registrations/:id", method: "get", action: "read", path: (r) => `/api/registrations/${r._id}` },
  { name: "PUT /registrations/:id/cancel", method: "put", action: "write", path: (r) => `/api/registrations/${r._id}/cancel` },
  {
    name: "GET /registrations/:id/sessions/:sessionId/checkin-qr",
    method: "get",
    action: "write",
    path: (r) => `/api/registrations/${r._id}/sessions/${session._id}/checkin-qr`,
    // attendance routes require an eligible (approved + confirmed) registration
    attendance: true,
  },
  {
    name: "POST /registrations/:id/sessions/:sessionId/attendance/self",
    method: "post",
    action: "read",
    path: (r) => `/api/registrations/${r._id}/sessions/${session._id}/attendance/self`,
    attendance: true,
    // PORTAL-only (P5 B3): CRM gets 403 PORTAL_ONLY before any PDP call and
    // must use PUT .../attendance; another member's id is 403 NOT_OWNER.
    portalOnly: true,
  },
];

async function expectRegUntouchedWithStatus(reg, status = "pending") {
  const fresh = await Registration.findById(reg._id).lean();
  expect(fresh.status).toBe(status);
  expect(fresh.isActive).toBe(true);
  expect(fresh.sessionAttendance).toHaveLength(0);
}

describe.each(selfRoutes)("self-service $name", (route) => {
  const expectedStatus = route.attendance ? "confirmed" : "pending";
  const expectRegUntouched = (reg) => expectRegUntouchedWithStatus(reg, expectedStatus);
  beforeEach(async () => {
    if (!route.attendance) return;
    await Registration.updateMany(
      { _id: { $in: [regA._id, regB._id, regC._id] } },
      { $set: { status: "confirmed", approvalStatus: "approved" } },
    );
  });
  const newPerm = `registrations:${route.action}`;
  const legacyPerm = `events:${route.action}`;

  it("PORTAL owner with registrations:<action> (legacy denied) -> 200, only the new permission evaluated", async () => {
    const res = await send(route.method, route.path(regA), portalA({ pdpDeny: [legacyPerm] }));
    expect(res.status).toBe(200);
    expect(defaultPolicyMiddleware.calls).toEqual([newPerm]);
  });

  it.each(["UNKNOWN_RESOURCE", "INSUFFICIENT_RESOURCE_PERMISSION", "MISSING_PERMISSION", "PERMISSION_NOT_DEFINED"])(
    "PORTAL owner, new permission absent (%s), legacy events:<action> held -> 200 via transition fallback",
    async (reason) => {
      const res = await send(route.method, route.path(regA), portalA({ pdpDeny: [newPerm], pdpReason: reason }));
      expect(res.status).toBe(200);
      expect(defaultPolicyMiddleware.calls).toEqual([newPerm, legacyPerm]);
    },
  );

  it.each(["TENANT_SCOPE_VIOLATION", "INVALID_TOKEN", "EVALUATION_ERROR", "RETIRED_ROLE_REAUTH_REQUIRED", "INVALID_USER_TYPE"])(
    "PORTAL owner, new permission denied for a non-absence reason (%s) -> 403, NO fallback, untouched",
    async (reason) => {
      const res = await send(route.method, route.path(regA), portalA({ pdpDeny: [newPerm], pdpReason: reason }));
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe(reason);
      expect(defaultPolicyMiddleware.calls).toEqual([newPerm]);
      await expectRegUntouched(regA);
    },
  );

  it("PDP outage (POLICY_SERVICE_ERROR) -> fails closed, NO fallback, untouched", async () => {
    const res = await send(route.method, route.path(regA), portalA({ pdpError: true }));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("POLICY_SERVICE_ERROR");
    expect(defaultPolicyMiddleware.calls).toEqual([newPerm]);
    await expectRegUntouched(regA);
  });

  it("PORTAL owner with neither permission -> 403 PERMISSION_DENIED, untouched", async () => {
    const res = await send(route.method, route.path(regA), portalA({ pdpDeny: [newPerm, legacyPerm] }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
    expect(defaultPolicyMiddleware.calls).toEqual([newPerm, legacyPerm]);
    await expectRegUntouched(regA);
  });

  it("the fallback evaluates the EXACT legacy action, never another one", async () => {
    const other = route.action === "read" ? "write" : "read";
    const res = await send(route.method, route.path(regA), portalA({ pdpDeny: [newPerm, legacyPerm] }));
    expect(res.status).toBe(403);
    expect(defaultPolicyMiddleware.calls).not.toContain(`events:${other}`);
  });

  it("PORTAL A (holding both permissions) on B, same tenant -> denied, untouched", async () => {
    const res = await send(route.method, route.path(regB), portalA());
    expect(res.status).toBe(route.otherStatus || 403);
    if (!route.otherStatus) expect(res.body.code).toBe("NOT_OWNER");
    await expectRegUntouched(regB);
  });

  it("PORTAL A (holding both permissions) on C, other tenant -> denied, untouched", async () => {
    const res = await send(route.method, route.path(regC), portalA());
    expect(res.status).toBe(route.otherStatus || 403);
    await expectRegUntouched(regC);
  });

  it("CRM: events:<action> via the policy middleware only - registrations:* never evaluated, no fallback", async () => {
    const res = await send(route.method, route.path(regB), crm());
    if (route.portalOnly) {
      // PORTAL-only route: CRM is refused by caller class, the PDP is never consulted.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PORTAL_ONLY");
      expect(defaultPolicyMiddleware.calls).toEqual([]);
      await expectRegUntouched(regB);
      return;
    }
    expect(defaultPolicyMiddleware.calls).toEqual([legacyPerm]);
    expect([401, 403]).not.toContain(res.status);
  });

  it("CRM without events:<action> -> 403 (no fallback for CRM)", async () => {
    const res = await send(route.method, route.path(regB), crm(), { headers: { "x-test-pdp-deny": legacyPerm } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(route.portalOnly ? "PORTAL_ONLY" : "PERMISSION_DENIED");
    expect(defaultPolicyMiddleware.calls).toEqual(route.portalOnly ? [] : [legacyPerm]);
    await expectRegUntouched(regB);
  });

  it("unknown / missing userType -> 403, PDP never consulted", async () => {
    for (const auth of [unknownType(), noType()]) {
      const res = await send(route.method, route.path(regA), auth);
      expect(res.status).toBe(403);
    }
    expect(defaultPolicyMiddleware.calls).toEqual([]);
    await expectRegUntouched(regA);
  });
});

describe("GET /registrations/mine", () => {
  it("PORTAL with registrations:read only -> own registrations only", async () => {
    const res = await send("get", "/api/registrations/mine", portalA({ pdpDeny: ["events:read"] }));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => String(r._id))).toEqual([String(regA._id)]);
    expect(defaultPolicyMiddleware.calls).toEqual(["registrations:read"]);
  });

  it("PORTAL with only legacy events:read (new absent) -> 200 via fallback", async () => {
    const res = await send("get", "/api/registrations/mine", portalA({ pdpDeny: ["registrations:read"] }));
    expect(res.status).toBe(200);
    expect(defaultPolicyMiddleware.calls).toEqual(["registrations:read", "events:read"]);
  });

  it("PORTAL with neither -> 403", async () => {
    const res = await send("get", "/api/registrations/mine", portalA({ pdpDeny: ["registrations:read", "events:read"] }));
    expect(res.status).toBe(403);
  });

  it("PORTAL of tenant C never sees tenant A rows", async () => {
    const res = await send("get", "/api/registrations/mine", portalC());
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => String(r._id))).toEqual([String(regC._id)]);
  });

  it("unknown / missing userType -> 403", async () => {
    for (const auth of [unknownType(), noType()]) {
      const res = await send("get", "/api/registrations/mine", auth);
      expect(res.status).toBe(403);
    }
  });
});

describe("requireRegistrationPermission / evaluatePermission (unit)", () => {
  function run(mw, req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(c) {
          this.statusCode = c;
          return this;
        },
        json(body) {
          resolve({ status: this.statusCode, body });
          return this;
        },
      };
      mw(req, res, () => resolve({ status: "next" }));
    });
  }
  const portalReq = (pdp) => ({ user: { userType: "PORTAL" }, headers: { authorization: portalA(pdp) } });

  it("fallback switched off: PORTAL needs registrations:<action> (the 'pass without fallback' retirement check)", async () => {
    const mw = requireRegistrationPermission("read", { legacyFallback: false });
    expect(await run(mw, portalReq({ pdpDeny: ["registrations:read"] }))).toEqual(expect.objectContaining({ status: 403 }));
    expect(await run(mw, portalReq({ pdpDeny: ["events:read"] }))).toEqual({ status: "next" });
  });

  it("an evaluation that throws fails closed (500), no fallback", async () => {
    const evaluate = jest.fn().mockRejectedValue(new Error("boom"));
    const mw = requireRegistrationPermission("read", { evaluate });
    const out = await run(mw, portalReq());
    expect(out.status).toBe(500);
    expect(out.body.code).toBe("POLICY_SERVICE_ERROR");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("on PERMIT sets req.user/req.userId/req.tenantId like the policy middleware", async () => {
    const mw = requireRegistrationPermission("read");
    const req = portalReq();
    expect(await run(mw, req)).toEqual({ status: "next" });
    expect(req.userId).toBe(USER_A);
    expect(req.tenantId).toBe(TENANT);
    expect(req.user.userType).toBe("PORTAL");
    expect(req.policyContext.decision).toBe("PERMIT");
  });

  it("unknown caller type -> 403 FORBIDDEN_CALLER without consulting the PDP", async () => {
    const evaluate = jest.fn();
    const mw = requireRegistrationPermission("create", { evaluate });
    const out = await run(mw, { user: { userType: "SERVICE" }, headers: {} });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("FORBIDDEN_CALLER");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("evaluatePermission never sends body/query values as context", async () => {
    const spy = jest.spyOn(defaultPolicyMiddleware.policyClient, "evaluatePolicy");
    await evaluatePermission(
      { headers: { authorization: portalA() }, body: { tenantId: "evil", userId: "evil" }, query: { tenantId: "evil" } },
      "registrations",
      "read",
    );
    const context = spy.mock.calls[0][3];
    expect(JSON.stringify(context)).not.toContain("evil");
    spy.mockRestore();
  });

  it("evaluatePermission with no credentials -> DENY 401, PDP not called", async () => {
    const spy = jest.spyOn(defaultPolicyMiddleware.policyClient, "evaluatePolicy");
    const out = await evaluatePermission({ headers: {} }, "registrations", "read");
    expect(out).toEqual(expect.objectContaining({ decision: "DENY", status: 401 }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("documents exactly which PDP reasons count as 'absent'", () => {
    expect([...LEGACY_FALLBACK_ABSENT_REASONS].sort()).toEqual(
      ["INSUFFICIENT_RESOURCE_PERMISSION", "MISSING_PERMISSION", "PERMISSION_NOT_DEFINED", "UNKNOWN_RESOURCE"],
    );
  });
});

// ---------------------------------------------------------------------------
// 3. createRegistration identity trust + 4. tier eligibility.
// ---------------------------------------------------------------------------
function createBody(overrides = {}) {
  counter += 1;
  return {
    registrationType: "event",
    eventId: String(event._id),
    paymentMethod: "stripe",
    registeredVia: "portal",
    profile: { email: `p5b2-create-${counter}@example.test`, firstName: "Ann", lastName: "A" },
    ...overrides,
  };
}

describe("POST /registrations - PORTAL identity is the verified caller", () => {
  it("portal supplying B's profileId registers as ITSELF (own profile), never as B", async () => {
    getCallerOwnProfile.mockResolvedValue({ profileId: "profile-a", membershipNumber: "M-A" });
    const body = createBody({
      registeredVia: "crm",
      registeredByUserId: "spoofed-staff",
      profile: { email: "attacker@example.test", profileId: "profile-b", membershipNumber: "M-B" },
    });
    const res = await send("post", "/api/registrations", portalA(), { body });
    expect(res.status).toBe(201);
    const reg = await Registration.findById(res.body.data.registration._id).lean();
    expect(reg.duplicateReview.status).toBe("CONFIRMED_LINK");
    expect(reg.duplicateReview.matchedProfileId).toBe("profile-a");
    expect(reg.membershipNumber).toBe("M-A");
    expect(reg.registeredVia).toBe("portal");
    expect(reg.registeredByUserId).toBeNull();
    expect(reg.submittedByUserId).toBe(USER_A);
    expect(getActiveMembership).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-a" }));
    expect(getActiveMembership).not.toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-b" }));
    expect(getProfileMembershipNumber).not.toHaveBeenCalled();
    expect(createRegistrationPaymentIntent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ profileId: "profile-a", membershipNumber: "M-A" }),
    );
  });

  it("portal with no own profile supplying B's profileId: B is ignored, priced as non-member", async () => {
    const res = await send("post", "/api/registrations", portalA(), {
      body: createBody({ profile: { email: "nobody@example.test", profileId: "profile-b" } }),
    });
    expect(res.status).toBe(201);
    const reg = await Registration.findById(res.body.data.registration._id).lean();
    expect(reg.duplicateReview.matchedProfileId).toBeNull();
    expect(reg.membershipNumber).toBeNull();
    expect(reg.amount).toBe(8000); // nonMemberPrice 80 EUR
    expect(getActiveMembership).toHaveBeenCalledWith(expect.objectContaining({ profileId: null }));
  });

  it("portal with no own profile whose details EXACT-match B: downgraded to POTENTIAL_MATCH, not linked/priced as B", async () => {
    checkAttendeeDuplicates.mockResolvedValue({ resolution: "exact", profileId: "profile-b", membershipNumber: "M-B" });
    const res = await send("post", "/api/registrations", portalA(), {
      body: createBody({ profile: { email: "b-member@example.test" } }),
    });
    expect(res.status).toBe(201);
    const reg = await Registration.findById(res.body.data.registration._id).lean();
    expect(reg.duplicateReview.status).toBe("POTENTIAL_MATCH");
    expect(reg.duplicateReview.matchedProfileId).toBeNull();
    expect(reg.membershipNumber).toBeNull();
    expect(getActiveMembership).toHaveBeenCalledWith(expect.objectContaining({ profileId: null }));
  });

  it("own-profile lookup failure -> 503 PROFILE_LOOKUP_FAILED, nothing created (fail closed)", async () => {
    getCallerOwnProfile.mockRejectedValue(new Error("profile-service down"));
    const res = await send("post", "/api/registrations", portalA(), { body: createBody() });
    expect(res.status).toBe(503);
    expect(res.body.error.code || res.body.code).toBe("PROFILE_LOOKUP_FAILED");
    expect(await Registration.countDocuments({ tenantId: TENANT, submittedByUserId: USER_A })).toBe(1); // only regA
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });

  it("CRM may still target another profile (existing behaviour); registeredVia/registeredBy from the verified caller", async () => {
    getProfileMembershipNumber.mockResolvedValue("M-B");
    const res = await send("post", "/api/registrations", crm(), {
      body: createBody({
        registeredVia: "portal",
        registeredByUserId: "someone-else",
        profile: { email: "b@example.test", profileId: "profile-b" },
      }),
    });
    expect(res.status).toBe(201);
    const reg = await Registration.findById(res.body.data.registration._id).lean();
    expect(reg.duplicateReview.matchedProfileId).toBe("profile-b");
    expect(reg.membershipNumber).toBe("M-B");
    expect(reg.registeredVia).toBe("crm");
    expect(reg.registeredByUserId).toBe(CRM_USER);
    expect(getCallerOwnProfile).not.toHaveBeenCalled();
  });

  it("permissions: PORTAL registrations:create -> 201; legacy events:create only -> 201; neither -> 403", async () => {
    let res = await send("post", "/api/registrations", portalA({ pdpDeny: ["events:create"] }), { body: createBody() });
    expect(res.status).toBe(201);
    res = await send("post", "/api/registrations", portalA({ pdpDeny: ["registrations:create"] }), {
      body: createBody(),
    });
    expect(res.status).toBe(201);
    res = await send("post", "/api/registrations", portalA({ pdpDeny: ["registrations:create", "events:create"] }), {
      body: createBody(),
    });
    expect(res.status).toBe(403);
    res = await send("post", "/api/registrations", portalA({ pdpError: true }), { body: createBody() });
    expect(res.status).toBe(403);
  });

  it("permissions: CRM without events:create -> 403; unknown/missing userType -> 403", async () => {
    let res = await send("post", "/api/registrations", crm(), {
      body: createBody(),
      headers: { "x-test-pdp-deny": "events:create" },
    });
    expect(res.status).toBe(403);
    for (const auth of [unknownType(), noType()]) {
      res = await send("post", "/api/registrations", auth, { body: createBody() });
      expect(res.status).toBe(403);
    }
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("POST /registrations - PORTAL tier eligibility is server-checked", () => {
  it("non-member PORTAL choosing the MEMBER tier -> 400 TIER_NOT_ELIGIBLE, nothing created", async () => {
    const res = await send("post", "/api/registrations", portalA(), {
      body: createBody({ lineItems: [{ tierKey: "MEMBER", quantity: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code || res.body.code).toBe("TIER_NOT_ELIGIBLE");
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
  });

  it("verified active member (own profile) choosing MEMBER -> 201 at the server's member price", async () => {
    getCallerOwnProfile.mockResolvedValue({ profileId: "profile-a", membershipNumber: "M-A" });
    getActiveMembership.mockResolvedValue({ isActiveMember: true, membershipCategory: "general" });
    const res = await send("post", "/api/registrations", portalA(), {
      body: createBody({ lineItems: [{ tierKey: "MEMBER", quantity: 1 }], amount: 1, price: 1 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.registration.amount).toBe(5000);
  });

  it("non-member PORTAL choosing NON_MEMBER -> 201 at the server's non-member price (client amount ignored)", async () => {
    const res = await send("post", "/api/registrations", portalA(), {
      body: createBody({ lineItems: [{ tierKey: "NON_MEMBER", quantity: 2 }], amount: 1 }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.registration.amount).toBe(16000);
  });

  it("CRM operator tier choice is unchanged (may pick MEMBER for a non-member attendee)", async () => {
    const res = await send("post", "/api/registrations", crm(), {
      body: createBody({ lineItems: [{ tierKey: "MEMBER", quantity: 1 }] }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.registration.amount).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// 5. Payment-method allow-list (server-side, per verified caller class).
// ---------------------------------------------------------------------------
describe("POST /registrations - payment-method allow-list", () => {
  async function expectNothingCreated() {
    expect(await Registration.countDocuments({ tenantId: TENANT })).toBe(2); // regA + regB only
    expect(postManualRegistrationPayment).not.toHaveBeenCalled();
    expect(createRegistrationPaymentIntent).not.toHaveBeenCalled();
    expect(getCallerOwnProfile).not.toHaveBeenCalled();
  }

  it.each(["manual", "comp", "invoice"])("PORTAL paymentMethod %s -> 403 PAYMENT_METHOD_NOT_ALLOWED, nothing created", async (m) => {
    const res = await send("post", "/api/registrations", portalA(), { body: createBody({ paymentMethod: m }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("PAYMENT_METHOD_NOT_ALLOWED");
    await expectNothingCreated();
  });

  it.each([portalA, crm])("global_payments -> 400 PAYMENT_METHOD_NOT_SUPPORTED for every caller (%#), not a 500", async (auth) => {
    const res = await send("post", "/api/registrations", auth(), {
      body: createBody({ paymentMethod: "global_payments", globalPaymentsTransactionId: "gp_1" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PAYMENT_METHOD_NOT_SUPPORTED");
    await expectNothingCreated();
  });

  it("an unknown method -> 400 PAYMENT_METHOD_NOT_SUPPORTED", async () => {
    const res = await send("post", "/api/registrations", crm(), { body: createBody({ paymentMethod: "cash" }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PAYMENT_METHOD_NOT_SUPPORTED");
    await expectNothingCreated();
  });

  it("PORTAL stripe (explicit or defaulted) -> 201", async () => {
    let res = await send("post", "/api/registrations", portalA(), { body: createBody({ paymentMethod: "stripe" }) });
    expect(res.status).toBe(201);
    const body = createBody();
    delete body.paymentMethod;
    res = await send("post", "/api/registrations", portalA(), { body });
    expect(res.status).toBe(201);
    expect(res.body.data.registration.paymentMethod).toBe("stripe");
  });

  it.each(["stripe", "manual", "comp", "invoice"])("CRM paymentMethod %s -> 201", async (m) => {
    const res = await send("post", "/api/registrations", crm(), { body: createBody({ paymentMethod: m }) });
    expect(res.status).toBe(201);
    expect(res.body.data.registration.paymentMethod).toBe(m);
  });

  it("unknown / missing caller type -> 403 before any payment-method handling", async () => {
    for (const auth of [unknownType(), noType()]) {
      const res = await send("post", "/api/registrations", auth, { body: createBody({ paymentMethod: "comp" }) });
      expect(res.status).toBe(403);
    }
    await expectNothingCreated();
  });
});
