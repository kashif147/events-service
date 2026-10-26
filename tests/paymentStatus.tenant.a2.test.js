// Phase A / A2 — payments.events.status.updated.v1 is bound to the event tenant.
// The registration is loaded with { _id, tenantId: <event tenant> }; missing / mismatched /
// placeholder tenants and records belonging to another tenant cause no mutation and no throw.
jest.mock("../models/registration.model.js", () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js", () => ({
  publishRegistrationConfirmed: jest.fn().mockResolvedValue(),
}));

const Registration = require("../models/registration.model.js");
const { publishRegistrationConfirmed } = require("../rabbitMQ/publishers/registration.events.publisher.js");
const { handlePaymentStatusUpdated } = require("../rabbitMQ/listeners/payment.status.listener.js");
const { resolveEventTenant } = require("../rabbitMQ/eventTenant.js");

const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const REG = "6a1111111111111111111111";

const fakeReg = (tenantId, extra = {}) => ({
  _id: REG,
  tenantId,
  approvalStatus: "pending_review",
  paymentStatus: "pending",
  status: "pending",
  save: jest.fn().mockResolvedValue(),
  ...extra,
});
// The mocked store only returns a registration when the filter's tenant matches its owner.
const storeWith = (reg) =>
  Registration.findOne.mockImplementation(async (f) =>
    String(f._id) === String(reg._id) && f.tenantId === reg.tenantId ? reg : null,
  );
const evt = (tenantId, data = {}, extra = {}) => ({
  eventId: "evt-1",
  tenantId,
  data: { registrationId: REG, status: "succeeded", tenantId, ...data },
  ...extra,
});

let warn;
beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

test("valid tenant: registration of that tenant is confirmed", async () => {
  const reg = fakeReg(A);
  storeWith(reg);
  await handlePaymentStatusUpdated(evt(A), { headers: { "x-tenant-id": A } });
  expect(Registration.findOne).toHaveBeenCalledWith({ _id: REG, tenantId: A });
  expect(Registration.findById).not.toHaveBeenCalled();
  expect(reg.save).toHaveBeenCalled();
  expect(reg.status).toBe("confirmed");
  expect(publishRegistrationConfirmed).toHaveBeenCalledWith(reg, A);
});

test("missing tenant: rejected, no lookup, no mutation", async () => {
  await handlePaymentStatusUpdated({ eventId: "e", data: { registrationId: REG, status: "succeeded" } }, { headers: {} });
  expect(Registration.findOne).not.toHaveBeenCalled();
  expect(publishRegistrationConfirmed).not.toHaveBeenCalled();
  expect(warn.mock.calls[0][0]).toMatch(/EventTenantRejected/);
});

test("mismatched tenant (envelope A, data B): rejected, no mutation", async () => {
  const reg = fakeReg(A);
  storeWith(reg);
  await handlePaymentStatusUpdated(evt(A, { tenantId: B }), {});
  expect(Registration.findOne).not.toHaveBeenCalled();
  expect(reg.save).not.toHaveBeenCalled();
});

test("header tenant disagreeing with envelope: rejected", async () => {
  await handlePaymentStatusUpdated(evt(A), { headers: { "x-tenant-id": B } });
  expect(Registration.findOne).not.toHaveBeenCalled();
});

test("same registration id owned by another tenant: no cross-tenant mutation", async () => {
  const regOfA = fakeReg(A);
  storeWith(regOfA);
  await handlePaymentStatusUpdated(evt(B), { headers: { "x-tenant-id": B } });
  expect(Registration.findOne).toHaveBeenCalledWith({ _id: REG, tenantId: B });
  expect(regOfA.save).not.toHaveBeenCalled();
  expect(regOfA.status).toBe("pending");
  expect(publishRegistrationConfirmed).not.toHaveBeenCalled();
});

test("placeholder tenant is rejected", async () => {
  await handlePaymentStatusUpdated(evt("unknown"), {});
  expect(Registration.findOne).not.toHaveBeenCalled();
});

test("malformed registrationId is skipped without a throw", async () => {
  await expect(handlePaymentStatusUpdated(evt(A, { registrationId: "not-an-id" }), {})).resolves.toBeUndefined();
  expect(Registration.findOne).not.toHaveBeenCalled();
});

test("resolver: envelope canonical, data fallback, mismatch/missing rejected", () => {
  expect(resolveEventTenant({ tenantId: A }, {})).toEqual({ ok: true, tenantId: A });
  expect(resolveEventTenant({ data: { tenantId: A } }, {})).toEqual({ ok: true, tenantId: A });
  expect(resolveEventTenant({ tenantId: A, data: { tenantId: B } }, {})).toEqual({ ok: false, reason: "mismatch" });
  expect(resolveEventTenant({}, {})).toEqual({ ok: false, reason: "missing" });
});
