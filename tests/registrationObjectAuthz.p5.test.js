/**
 * P5 portal object authorization - registration routes.
 *
 * Matrix: A portal on own (allowed where intended), A on B same tenant
 * (denied), A on C other tenant (denied), CRM + permission (allowed,
 * tenant-scoped), CRM without permission (denied), portal holding the
 * permission string but not owner / not CRM (denied), portal approve/reject
 * always denied. The PDP is mocked: it permits unless the test sends
 * x-test-pdp: deny (simulating a CRM user without events:*).
 */
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middlewares/policy.middleware.js", () => {
  const calls = [];
  const defaultPolicyMiddleware = {
    calls,
    requirePermission: (resource, action) => (req, res, next) => {
      calls.push(`${resource}:${action}`);
      if (req.headers["x-test-pdp"] === "deny") {
        return res.status(403).json({ success: false, error: "Permission denied", code: "PERMISSION_DENIED", status: 403 });
      }
      return next();
    },
  };
  return Object.assign(defaultPolicyMiddleware, { defaultPolicyMiddleware });
});
jest.mock("../services/accountService.client.js");
jest.mock("../services/profileLookup.client.js");
jest.mock("../services/lookup.client.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");
jest.mock("../services/registrationApproval.service.js", () => {
  const actual = jest.requireActual("../services/registrationApproval.service.js");
  return { ...actual, finalizeRegistrationApproval: jest.fn() };
});

const { createRegistrationPaymentIntent } = require("../services/accountService.client.js");
const { checkAttendeeDuplicates } = require("../services/profileLookup.client.js");
const { resolveLookupNamesByIds } = require("../services/lookup.client.js");
const { finalizeRegistrationApproval } = require("../services/registrationApproval.service.js");

const app = require("../app");
const Registration = require("../models/registration.model.js");
const EventSession = require("../models/eventSession.model.js");

const TENANT = "tenant-p5-authz-a";
const OTHER_TENANT = "tenant-p5-authz-c";
const USER_A = "portal-user-a";
const USER_B = "portal-user-b";
const USER_C = "portal-user-c";
const CRM_USER = "crm-user-1";

function bearer({ sub, tenantId = TENANT, userType }) {
  const claims = { sub, tenantId, roles: [] };
  if (userType !== undefined) claims.userType = userType;
  return `Bearer ${jwt.sign(claims, process.env.JWT_SECRET)}`;
}
const portalA = () => bearer({ sub: USER_A, userType: "PORTAL" });
const crm = () => bearer({ sub: CRM_USER, userType: "CRM" });

let counter = 0;
function makeRegistration(overrides = {}) {
  counter += 1;
  const email = `p5-attendee-${counter}@example.test`;
  return Registration.create({
    tenantId: TENANT,
    registrationType: "event",
    eventId: new mongoose.Types.ObjectId(),
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

let regA;
let regB;
let regC;
let regCrmCreated;
let session;
let sessionC;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

beforeEach(async () => {
  regA = await makeRegistration({ submittedByUserId: USER_A });
  regB = await makeRegistration({ submittedByUserId: USER_B });
  regC = await makeRegistration({ tenantId: OTHER_TENANT, submittedByUserId: USER_C });
  regCrmCreated = await makeRegistration({ submittedByUserId: null, registeredVia: "crm" });
  session = await EventSession.create({ tenantId: TENANT, eventId: regA.eventId, label: "Day 1", date: new Date() });
  sessionC = await EventSession.create({ tenantId: OTHER_TENANT, eventId: regC.eventId, label: "Day 1", date: new Date() });
  resolveLookupNamesByIds.mockResolvedValue(new Map());
});

afterEach(async () => {
  await Registration.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } });
  await EventSession.deleteMany({ tenantId: { $in: [TENANT, OTHER_TENANT] } });
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

async function expectUntouched(reg) {
  const fresh = await Registration.findById(reg._id).lean();
  expect(fresh.status).toBe(reg.status);
  expect(fresh.approvalStatus).toBe(reg.approvalStatus);
  expect(fresh.isActive).toBe(true);
  expect(fresh.attendeeSnapshot.email).toBe(reg.attendeeSnapshot.email);
}

// ---------------------------------------------------------------------------
// Staff-only routes: PORTAL denied (CRM_ONLY) even for its own registration;
// CRM needs the PDP permission.
// ---------------------------------------------------------------------------
const staffRoutes = [
  { name: "GET / (CRM grid)", method: "get", path: () => "/api/registrations" },
  { name: "GET /profile/:profileId", method: "get", path: () => "/api/registrations/profile/some-profile" },
  {
    name: "POST /attendee-duplicate-check",
    method: "post",
    path: () => "/api/registrations/attendee-duplicate-check",
    body: { email: "someone@example.test" },
  },
  {
    name: "PUT /:id/attendee",
    method: "put",
    path: (r) => `/api/registrations/${r._id}/attendee`,
    body: { profile: { email: "changed@example.test", firstName: "X" } },
  },
  { name: "PUT /:id/approve", method: "put", path: (r) => `/api/registrations/${r._id}/approve` },
  { name: "PUT /:id/reject", method: "put", path: (r) => `/api/registrations/${r._id}/reject` },
  { name: "POST /:id/retry-payment", method: "post", path: (r) => `/api/registrations/${r._id}/retry-payment` },
  {
    name: "PUT /:id/sessions/:sessionId/attendance (CRM)",
    method: "put",
    path: (r) => `/api/registrations/${r._id}/sessions/${session._id}/attendance`,
    body: { status: "attended" },
  },
];

describe.each(staffRoutes)("staff-only $name", (route) => {
  const send = (auth, reg, headers = {}) => {
    let req = request(app)[route.method](route.path(reg)).set("Authorization", auth);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return route.body ? req.send(route.body) : req;
  };

  it("PORTAL A on own registration (holding events:* per mocked PDP) -> 403 CRM_ONLY, untouched", async () => {
    const res = await send(portalA(), regA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    await expectUntouched(regA);
  });

  it("PORTAL A on B (same tenant) -> 403 CRM_ONLY, untouched", async () => {
    const res = await send(portalA(), regB);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    await expectUntouched(regB);
  });

  it("PORTAL A on C (other tenant) -> 403 CRM_ONLY, untouched", async () => {
    const res = await send(portalA(), regC);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
    await expectUntouched(regC);
  });

  it("missing userType -> 403 CRM_ONLY (fail closed)", async () => {
    const res = await send(bearer({ sub: USER_A }), regA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CRM_ONLY");
  });

  it("CRM without permission -> 403 from PDP, untouched", async () => {
    const res = await send(crm(), regB, { "x-test-pdp": "deny" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
    await expectUntouched(regB);
  });

  it("CRM on another tenant's registration is not reachable (tenant-scoped)", async () => {
    if (route.path(regC) === route.path(regA)) return; // collection routes: covered by the CRM list test
    const res = await send(crm(), regC);
    expect(res.status).not.toBe(200);
    await expectUntouched(regC);
  });
});

describe("staff-only routes: CRM + permission allowed", () => {
  it("GET / lists the tenant's registrations only", async () => {
    const res = await request(app).get("/api/registrations").set("Authorization", crm());
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r) => String(r._id));
    expect(ids).toEqual(expect.arrayContaining([String(regA._id), String(regB._id), String(regCrmCreated._id)]));
    expect(ids).not.toContain(String(regC._id));
  });

  it("GET /profile/:profileId", async () => {
    await Registration.updateOne({ _id: regB._id }, { $set: { profileId: "profile-b" } });
    const res = await request(app).get("/api/registrations/profile/profile-b").set("Authorization", crm());
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => String(r._id))).toEqual([String(regB._id)]);
  });

  it("POST /attendee-duplicate-check", async () => {
    checkAttendeeDuplicates.mockResolvedValue({ status: "NO_MATCH" });
    const res = await request(app)
      .post("/api/registrations/attendee-duplicate-check")
      .set("Authorization", crm())
      .send({ email: "someone@example.test" });
    expect(res.status).toBe(200);
  });

  it("PUT /:id/attendee", async () => {
    const res = await request(app)
      .put(`/api/registrations/${regB._id}/attendee`)
      .set("Authorization", crm())
      .send({ profile: { email: "crm-edit@example.test" } });
    expect(res.status).toBe(200);
    const fresh = await Registration.findById(regB._id).lean();
    expect(fresh.attendeeSnapshot.email).toBe("crm-edit@example.test");
  });

  it("PUT /:id/approve", async () => {
    finalizeRegistrationApproval.mockResolvedValue({ approved: true });
    const res = await request(app).put(`/api/registrations/${regB._id}/approve`).set("Authorization", crm());
    expect(res.status).toBe(200);
    expect(finalizeRegistrationApproval).toHaveBeenCalledTimes(1);
  });

  it("PUT /:id/reject", async () => {
    const res = await request(app).put(`/api/registrations/${regB._id}/reject`).set("Authorization", crm());
    expect(res.status).toBe(200);
    const fresh = await Registration.findById(regB._id).lean();
    expect(fresh.approvalStatus).toBe("rejected");
  });

  it("POST /:id/retry-payment", async () => {
    createRegistrationPaymentIntent.mockResolvedValue({
      id: "payment-x",
      paymentIntentId: "pi_x",
      clientSecret: "pi_x_secret",
      status: "requires_payment_method",
    });
    const res = await request(app).post(`/api/registrations/${regB._id}/retry-payment`).set("Authorization", crm());
    expect(res.status).toBe(200);
  });

  it("PUT /:id/sessions/:sessionId/attendance", async () => {
    const res = await request(app)
      .put(`/api/registrations/${regB._id}/sessions/${session._id}/attendance`)
      .set("Authorization", crm())
      .send({ status: "attended" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Dual routes: CRM tenant-wide; PORTAL only on its own registration
// (submittedByUserId == verified user id). Same 403 NOT_OWNER for
// other-member / other-tenant / nonexistent (no existence leak).
// ---------------------------------------------------------------------------
const dualRoutes = [
  { name: "GET /:id", method: "get", path: (id) => `/api/registrations/${id}` },
  { name: "PUT /:id/cancel", method: "put", path: (id) => `/api/registrations/${id}/cancel` },
  {
    name: "GET /:id/sessions/:sessionId/checkin-qr",
    method: "get",
    path: (id, sid) => `/api/registrations/${id}/sessions/${sid || session._id}/checkin-qr`,
  },
];

describe.each(dualRoutes)("dual $name", (route) => {
  const send = (auth, id, sid, headers = {}) => {
    let req = request(app)[route.method](route.path(id, sid)).set("Authorization", auth);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req;
  };

  it("PORTAL A on own registration -> 200", async () => {
    const res = await send(portalA(), regA._id);
    expect(res.status).toBe(200);
  });

  it("PORTAL A on B (same tenant) -> 403 NOT_OWNER, untouched", async () => {
    const res = await send(portalA(), regB._id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    expect(JSON.stringify(res.body)).not.toContain(regB.attendeeSnapshot.email);
    await expectUntouched(regB);
  });

  it("PORTAL A on a CRM-created registration (submittedByUserId null) -> 403 NOT_OWNER", async () => {
    const res = await send(portalA(), regCrmCreated._id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    await expectUntouched(regCrmCreated);
  });

  it("PORTAL A on C (other tenant) -> 403 NOT_OWNER, untouched", async () => {
    const res = await send(portalA(), regC._id, sessionC._id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    await expectUntouched(regC);
  });

  it("PORTAL user of tenant C on tenant A's registration -> 403 NOT_OWNER", async () => {
    const res = await send(bearer({ sub: USER_C, tenantId: OTHER_TENANT, userType: "PORTAL" }), regA._id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
    await expectUntouched(regA);
  });

  it("PORTAL on nonexistent id -> same 403 NOT_OWNER (no existence leak)", async () => {
    const res = await send(portalA(), new mongoose.Types.ObjectId());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("NOT_OWNER");
  });

  it("unknown userType -> 403", async () => {
    const res = await send(bearer({ sub: USER_A, userType: "SOMETHING" }), regA._id);
    expect(res.status).toBe(403);
    await expectUntouched(regA);
  });

  it("missing userType -> 403", async () => {
    const res = await send(bearer({ sub: USER_A }), regA._id);
    expect(res.status).toBe(403);
    await expectUntouched(regA);
  });

  it("PORTAL owner without the PDP permission -> 403", async () => {
    const res = await send(portalA(), regA._id, undefined, { "x-test-pdp": "deny" });
    expect(res.status).toBe(403);
    await expectUntouched(regA);
  });

  it("CRM + permission on any tenant registration -> 200", async () => {
    const res = await send(crm(), regB._id);
    expect(res.status).toBe(200);
  });

  it("CRM + permission on another tenant's registration -> 404 (tenant-scoped)", async () => {
    const res = await send(crm(), regC._id, sessionC._id);
    expect(res.status).toBe(404);
    await expectUntouched(regC);
  });

  it("CRM without permission -> 403", async () => {
    const res = await send(crm(), regB._id, undefined, { "x-test-pdp": "deny" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
    await expectUntouched(regB);
  });
});

describe("dual routes: effects", () => {
  it("PORTAL A cancelling own registration cancels it", async () => {
    const res = await request(app).put(`/api/registrations/${regA._id}/cancel`).set("Authorization", portalA());
    expect(res.status).toBe(200);
    const fresh = await Registration.findById(regA._id).lean();
    expect(fresh.status).toBe("cancelled");
    expect(fresh.isActive).toBe(false);
  });

  it("PORTAL A by-id read returns own registration", async () => {
    const res = await request(app).get(`/api/registrations/${regA._id}`).set("Authorization", portalA());
    expect(res.status).toBe(200);
    expect(String(res.body.data._id)).toBe(String(regA._id));
  });
});

// ---------------------------------------------------------------------------
// Portal approve/reject always denied - own, other, other tenant.
// ---------------------------------------------------------------------------
describe("portal approve/reject always denied", () => {
  it.each(["approve", "reject"])("PORTAL %s on own/other/other-tenant -> 403 CRM_ONLY", async (action) => {
    for (const reg of [regA, regB, regC, regCrmCreated]) {
      const res = await request(app).put(`/api/registrations/${reg._id}/${action}`).set("Authorization", portalA());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CRM_ONLY");
      await expectUntouched(reg);
    }
    expect(finalizeRegistrationApproval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Self-scoped routes keep their existing behaviour.
// ---------------------------------------------------------------------------
describe("self-scoped routes unchanged", () => {
  it("GET /mine returns only the caller's own registrations", async () => {
    const res = await request(app).get("/api/registrations/mine").set("Authorization", portalA());
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => String(r._id))).toEqual([String(regA._id)]);
  });

  it("POST attendance/self: own -> 200, other member's -> 404", async () => {
    const own = await request(app)
      .post(`/api/registrations/${regA._id}/sessions/${session._id}/attendance/self`)
      .set("Authorization", portalA());
    expect(own.status).toBe(200);
    const other = await request(app)
      .post(`/api/registrations/${regB._id}/sessions/${session._id}/attendance/self`)
      .set("Authorization", portalA());
    expect(other.status).toBe(404);
  });
});
