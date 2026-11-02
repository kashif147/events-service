/**
 * P5 batch 2 - event administration is CRM-only; portal self-service
 * registration routes move onto registrations:<action> (with the temporary
 * legacy events:<action> fallback); createRegistration identity and tier
 * eligibility are derived from the verified caller.
 *
 * PDP is mocked. By default it permits. Headers:
 *   x-test-pdp: deny                     -> deny every permission
 *   x-test-pdp-deny: res:action,...      -> deny just those (or "registrations:*" / "events:*")
 */
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => {
  const calls = [];
  const isDenied = (req, resource, action) => {
    if (req.headers["x-test-pdp"] === "deny") return true;
    const list = String(req.headers["x-test-pdp-deny"] || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return list.includes(`${resource}:${action}`) || list.includes(`${resource}:*`);
  };
  const defaultPolicyMiddleware = {
    calls,
    requirePermission: (resource, action) => (req, res, next) => {
      calls.push(`${resource}:${action}`);
      if (isDenied(req, resource, action)) {
        return res
          .status(403)
          .json({ success: false, error: "Permission denied", code: "PERMISSION_DENIED", status: 403 });
      }
      return next();
    },
  };
  return Object.assign(defaultPolicyMiddleware, { defaultPolicyMiddleware });
});
jest.mock("../services/accountService.client.js");
jest.mock("../services/profileLookup.client.js");
jest.mock("../services/subscriptionLookup.client.js");
jest.mock("../services/lookup.client.js");
jest.mock("../services/certificateIssuance.service.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");

const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware.js");
const { postManualRegistrationPayment } = require("../services/accountService.client.js");
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
const Course = require("../models/course.model.js");
const Registration = require("../models/registration.model.js");
const Template = require("../models/template.model.js");
const { requireRegistrationPermission } = require("../middlewares/registrationPermission.mw.js");

const TENANT = "tenant-p5b2-a";
const OTHER_TENANT = "tenant-p5b2-c";
const USER_A = "p5b2-portal-a";
const USER_B = "p5b2-portal-b";
const USER_C = "p5b2-portal-c";
const CRM_USER = "64b000000000000000000c01"; // Template.userId is an ObjectId

function bearer({ sub, tenantId = TENANT, userType }) {
  const claims = { sub, tenantId, roles: [] };
  if (userType !== undefined) claims.userType = userType;
  return `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}`;
}
const portalA = () => bearer({ sub: USER_A, userType: "PORTAL" });
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
    memberPrice: 50,
    nonMemberPrice: 80,
    createdBy: CRM_USER,
  };
  event = await Event.create({ tenantId: TENANT, ...base });
  eventC = await Event.create({ tenantId: OTHER_TENANT, ...base });
  session = await EventSession.create({ tenantId: TENANT, eventId: event._id, label: "Day 1", date: new Date() });
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

  it("POST /events/:id/sessions adds a session", async () => {
    const res = await send("post", `/api/events/${event._id}/sessions`, crm(), {
      body: { label: "Day 2", date: "2030-01-02" },
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
  },
  {
    name: "POST /registrations/:id/sessions/:sessionId/attendance/self",
    method: "post",
    action: "read",
    path: (r) => `/api/registrations/${r._id}/sessions/${session._id}/attendance/self`,
    // self-scoped by construction: another member's id is a 404 (as before), never a write
    otherStatus: 404,
  },
];

describe.each(selfRoutes)("self-service $name", (route) => {
  const newPerm = `registrations:${route.action}`;
  const legacyPerm = `events:${route.action}`;

  it("PORTAL owner with registrations:<action> (legacy denied) -> 200, new permission evaluated first", async () => {
    const res = await send(route.method, route.path(regA), portalA(), { headers: { "x-test-pdp-deny": legacyPerm } });
    expect(res.status).toBe(200);
    expect(defaultPolicyMiddleware.calls).toEqual([newPerm]);
  });

  it("PORTAL owner with only the legacy events:<action> (transition fallback) -> 200", async () => {
    const res = await send(route.method, route.path(regA), portalA(), { headers: { "x-test-pdp-deny": newPerm } });
    expect(res.status).toBe(200);
    expect(defaultPolicyMiddleware.calls).toEqual([newPerm, legacyPerm]);
  });

  it("PORTAL owner with neither -> 403 PERMISSION_DENIED, untouched", async () => {
    const res = await send(route.method, route.path(regA), portalA(), {
      headers: { "x-test-pdp-deny": `${newPerm},${legacyPerm}` },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
    const fresh = await Registration.findById(regA._id).lean();
    expect(fresh.status).toBe("pending");
    expect(fresh.sessionAttendance).toHaveLength(0);
  });

  it("PORTAL A (holding both permissions) on B, same tenant -> denied, untouched", async () => {
    const res = await send(route.method, route.path(regB), portalA());
    expect(res.status).toBe(route.otherStatus || 403);
    if (!route.otherStatus) expect(res.body.code).toBe("NOT_OWNER");
    const fresh = await Registration.findById(regB._id).lean();
    expect(fresh.status).toBe("pending");
    expect(fresh.sessionAttendance).toHaveLength(0);
  });

  it("PORTAL A (holding both permissions) on C, other tenant -> denied, untouched", async () => {
    const res = await send(route.method, route.path(regC), portalA());
    expect(res.status).toBe(route.otherStatus || 403);
    const fresh = await Registration.findById(regC._id).lean();
    expect(fresh.status).toBe("pending");
    expect(fresh.sessionAttendance).toHaveLength(0);
  });

  it("CRM: events:<action> is the permission checked (registrations:* is irrelevant)", async () => {
    const res = await send(route.method, route.path(regB), crm(), { headers: { "x-test-pdp-deny": newPerm } });
    expect(defaultPolicyMiddleware.calls).toEqual([legacyPerm]);
    expect([401, 403]).not.toContain(res.status);
  });

  it("CRM without events:<action> -> 403 even if registrations:<action> would be permitted", async () => {
    const res = await send(route.method, route.path(regB), crm(), { headers: { "x-test-pdp-deny": legacyPerm } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
  });

  it("unknown / missing userType -> 403", async () => {
    for (const auth of [unknownType(), noType()]) {
      const res = await send(route.method, route.path(regA), auth);
      expect(res.status).toBe(403);
    }
    expect((await Registration.findById(regA._id).lean()).status).toBe("pending");
  });
});

describe("GET /registrations/mine", () => {
  it("PORTAL with registrations:read only -> own registrations only", async () => {
    const res = await send("get", "/api/registrations/mine", portalA(), { headers: { "x-test-pdp-deny": "events:read" } });
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => String(r._id))).toEqual([String(regA._id)]);
    expect(defaultPolicyMiddleware.calls).toEqual(["registrations:read"]);
  });

  it("PORTAL with only legacy events:read -> 200 via fallback", async () => {
    const res = await send("get", "/api/registrations/mine", portalA(), {
      headers: { "x-test-pdp-deny": "registrations:read" },
    });
    expect(res.status).toBe(200);
    expect(defaultPolicyMiddleware.calls).toEqual(["registrations:read", "events:read"]);
  });

  it("PORTAL with neither -> 403", async () => {
    const res = await send("get", "/api/registrations/mine", portalA(), {
      headers: { "x-test-pdp-deny": "registrations:read,events:read" },
    });
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

describe("requireRegistrationPermission (unit)", () => {
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
  const portalReq = (deny) => ({ user: { userType: "PORTAL" }, headers: { "x-test-pdp-deny": deny } });

  it("with the legacy fallback switched off, PORTAL needs registrations:<action>", async () => {
    const mw = requireRegistrationPermission("read", "read", { legacyFallback: false });
    expect(await run(mw, portalReq("registrations:read"))).toEqual(
      expect.objectContaining({ status: 403 }),
    );
    expect(await run(mw, portalReq("events:read"))).toEqual({ status: "next" });
  });

  it("a non-permission failure (e.g. PDP 500/401) is replayed, never falls back", async () => {
    const original = defaultPolicyMiddleware.requirePermission;
    defaultPolicyMiddleware.requirePermission = (resource) => (req, res, next) =>
      resource === "registrations"
        ? res.status(500).json({ success: false, code: "POLICY_SERVICE_ERROR" })
        : next();
    try {
      const mw = requireRegistrationPermission("read");
      const out = await run(mw, portalReq(""));
      expect(out).toEqual({ status: 500, body: { success: false, code: "POLICY_SERVICE_ERROR" } });
    } finally {
      defaultPolicyMiddleware.requirePermission = original;
    }
  });

  it("unknown caller type -> 403 FORBIDDEN_CALLER without consulting the PDP", async () => {
    const mw = requireRegistrationPermission("create");
    const out = await run(mw, { user: { userType: "SERVICE" }, headers: {} });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("FORBIDDEN_CALLER");
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
    paymentMethod: "manual",
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
    expect(postManualRegistrationPayment.mock.calls[0][0]).toEqual(
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
    expect(postManualRegistrationPayment).not.toHaveBeenCalled();
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
    let res = await send("post", "/api/registrations", portalA(), {
      body: createBody(),
      headers: { "x-test-pdp-deny": "events:create" },
    });
    expect(res.status).toBe(201);
    res = await send("post", "/api/registrations", portalA(), {
      body: createBody(),
      headers: { "x-test-pdp-deny": "registrations:create" },
    });
    expect(res.status).toBe(201);
    res = await send("post", "/api/registrations", portalA(), {
      body: createBody(),
      headers: { "x-test-pdp-deny": "registrations:create,events:create" },
    });
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
    expect(postManualRegistrationPayment).not.toHaveBeenCalled();
  });
});

describe("POST /registrations - PORTAL tier eligibility is server-checked", () => {
  it("non-member PORTAL choosing the MEMBER tier -> 400 TIER_NOT_ELIGIBLE, nothing created", async () => {
    const res = await send("post", "/api/registrations", portalA(), {
      body: createBody({ lineItems: [{ tierKey: "MEMBER", quantity: 1 }] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code || res.body.code).toBe("TIER_NOT_ELIGIBLE");
    expect(postManualRegistrationPayment).not.toHaveBeenCalled();
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
