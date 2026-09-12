const mongoose = require("mongoose");

jest.mock("../services/certificateIssuance.service.js");
const { createCertificateForRegistration } = require("../services/certificateIssuance.service.js");
const { maybeIssueCertificatesForCompletedEvent } = require("../services/autoCertificate.service.js");
const Registration = require("../models/registration.model.js");
const Certificate = require("../models/certificate.model.js");

const TENANT_ID = "tenant-auto-cert-test";

let attendeeCounter = 0;
async function createRegistrationDoc(eventId, overrides = {}) {
  attendeeCounter += 1;
  const email = `attendee${attendeeCounter}@example.com`;
  return Registration.create({
    tenantId: TENANT_ID,
    registrationType: "event",
    eventId,
    profileId: `profile-${attendeeCounter}`,
    attendeeSnapshot: { email, normalizedEmail: email },
    amount: 0,
    currency: "eur",
    paymentMethod: "comp",
    paymentStatus: "waived",
    status: "attended",
    approvalStatus: "approved",
    registeredVia: "crm",
    isActive: true,
    ...overrides,
  });
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(async () => {
  await Registration.deleteMany({ tenantId: TENANT_ID });
  await Certificate.deleteMany({ tenantId: TENANT_ID });
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("maybeIssueCertificatesForCompletedEvent", () => {
  const baseEvent = (overrides = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    autoIssueOnFinish: true,
    certificateTemplateId: "template-1",
    certificationType: "Digital Certificate",
    ...overrides,
  });

  it("does nothing when autoIssueOnFinish is false", async () => {
    const event = baseEvent({ autoIssueOnFinish: false });
    await createRegistrationDoc(event._id);

    const result = await maybeIssueCertificatesForCompletedEvent({ event, tenantId: TENANT_ID });
    expect(result.issued).toBe(0);
    expect(createCertificateForRegistration).not.toHaveBeenCalled();
  });

  it("does nothing when certificateTemplateId is not configured", async () => {
    const event = baseEvent({ certificateTemplateId: null });
    await createRegistrationDoc(event._id);

    const result = await maybeIssueCertificatesForCompletedEvent({ event, tenantId: TENANT_ID });
    expect(result.issued).toBe(0);
    expect(createCertificateForRegistration).not.toHaveBeenCalled();
  });

  it("only issues for 'attended' registrations, not 'no-show'", async () => {
    const event = baseEvent();
    const attended = await createRegistrationDoc(event._id, { status: "attended" });
    await createRegistrationDoc(event._id, { status: "no-show" });
    createCertificateForRegistration.mockResolvedValue({ _id: "cert-1" });

    const result = await maybeIssueCertificatesForCompletedEvent({ event, tenantId: TENANT_ID });

    expect(result.issued).toBe(1);
    expect(createCertificateForRegistration).toHaveBeenCalledTimes(1);
    expect(createCertificateForRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ _id: attended._id }),
        authHeaders: null,
        deliver: { email: true },
      }),
    );
  });

  it("is idempotent - does not re-issue if a non-revoked certificate already exists", async () => {
    const event = baseEvent();
    const registration = await createRegistrationDoc(event._id);
    await Certificate.create({
      tenantId: TENANT_ID,
      registrationId: registration._id,
      profileId: "profile-1",
      status: "issued",
    });

    const result = await maybeIssueCertificatesForCompletedEvent({ event, tenantId: TENANT_ID });
    expect(result.issued).toBe(0);
    expect(createCertificateForRegistration).not.toHaveBeenCalled();
  });

  it("does not set a deliver option for certificationType 'Paper Certificate'", async () => {
    const event = baseEvent({ certificationType: "Paper Certificate" });
    await createRegistrationDoc(event._id);
    createCertificateForRegistration.mockResolvedValue({ _id: "cert-1" });

    await maybeIssueCertificatesForCompletedEvent({ event, tenantId: TENANT_ID });

    expect(createCertificateForRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ deliver: undefined }),
    );
  });

  it("sets deliver for certificationType 'Both'", async () => {
    const event = baseEvent({ certificationType: "Both" });
    await createRegistrationDoc(event._id);
    createCertificateForRegistration.mockResolvedValue({ _id: "cert-1" });

    await maybeIssueCertificatesForCompletedEvent({ event, tenantId: TENANT_ID });

    expect(createCertificateForRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ deliver: { email: true } }),
    );
  });
});
