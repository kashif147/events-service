const mongoose = require("mongoose");

jest.mock("../services/communicationService.client.js");
jest.mock("../rabbitMQ/publishers/registration.events.publisher.js");

const { generateCertificateLetter, generateCertificateLetterInternal } = require("../services/communicationService.client.js");
const { publishCertificateIssued } = require("../rabbitMQ/publishers/registration.events.publisher.js");
const { createCertificateForRegistration } = require("../services/certificateIssuance.service.js");
const Certificate = require("../models/certificate.model.js");
const { AppError } = require("../errors/AppError.js");

const TENANT_ID = "tenant-cert-issuance-test";

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI);
});

afterEach(async () => {
  await Certificate.deleteMany({ tenantId: TENANT_ID });
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe("createCertificateForRegistration", () => {
  it("throws if the registration has no linked profile", async () => {
    const registration = { _id: new mongoose.Types.ObjectId(), profileId: null };
    await expect(
      createCertificateForRegistration({
        tenantId: TENANT_ID,
        actorId: "user-1",
        registration,
        event: null,
        templateId: "template-1",
        authHeaders: {},
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("calls the authenticated (manual) letter path when authHeaders is provided", async () => {
    const registration = { _id: new mongoose.Types.ObjectId(), profileId: "profile-1" };
    generateCertificateLetter.mockResolvedValue({ letterId: "letter-1" });

    const certificate = await createCertificateForRegistration({
      tenantId: TENANT_ID,
      actorId: "user-1",
      registration,
      event: { _id: new mongoose.Types.ObjectId(), title: "Test Event" },
      templateId: "template-1",
      authHeaders: { authorization: "Bearer xyz" },
    });

    expect(generateCertificateLetter).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-1", templateId: "template-1" }),
    );
    expect(generateCertificateLetterInternal).not.toHaveBeenCalled();
    expect(certificate.status).toBe("issued");
    expect(certificate.generatedLetterId).toBe("letter-1");
    expect(publishCertificateIssued).toHaveBeenCalled();
  });

  it("calls the internal (system) letter path when authHeaders is null - the auto-issuance case, using the attendee's own email for delivery", async () => {
    const registration = {
      _id: new mongoose.Types.ObjectId(),
      profileId: "profile-2",
      attendeeSnapshot: { email: "attendee@example.com" },
    };
    generateCertificateLetterInternal.mockResolvedValue({ letterId: "letter-2" });

    await createCertificateForRegistration({
      tenantId: TENANT_ID,
      actorId: null,
      registration,
      event: { _id: new mongoose.Types.ObjectId(), title: "Test Event" },
      templateId: "template-1",
      authHeaders: null,
      deliver: { email: true },
    });

    expect(generateCertificateLetterInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        profileId: "profile-2",
        deliver: { email: true, toAddress: "attendee@example.com" },
      }),
    );
    expect(generateCertificateLetter).not.toHaveBeenCalled();
  });
});
