const mongoose = require("mongoose");
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const { studentVerificationState } = require("../services/studentEligibility.service.js");
const { cancelPaymentIntent, voidManualRegistrationPayment } = require("../services/accountService.client.js");
const { publishRegistrationCancelled } = require("../rabbitMQ/publishers/registration.events.publisher.js");

const NOTE_MAX = 500;

/**
 * PUT /registrations/:id/student-verification  (CRM only, events:write - same gate as approve/reject)
 * Body: { decision: "verify" | "reject", note? }
 *
 * P5 STUDENT policy: the explicit CRM decision on a pending student pricing
 * claim (services/studentEligibility.service.js).
 *   verify - records who/when; approval (capture / GL post) is then allowed.
 *   reject - v1 rejects the REGISTRATION: releases the card authorization or
 *            voids the unposted manual payment (nothing was captured), then
 *            cancels it - same payment handling as PUT /:id/reject. Re-pricing
 *            is a separate, later flow.
 * Only a pending_review registration whose claim is still undecided can be
 * decided; the update is conditional on that state, so two concurrent
 * decisions cannot both apply.
 */
async function decideStudentVerification(req, res, next) {
  const { tenantId } = req.ctx;
  try {
    const { decision, note } = req.body || {};
    if (decision !== "verify" && decision !== "reject") {
      return next(AppError.badRequest("decision must be 'verify' or 'reject'"));
    }
    if (note !== undefined && note !== null && (typeof note !== "string" || note.length > NOTE_MAX)) {
      return next(AppError.badRequest(`note must be a string of at most ${NOTE_MAX} characters`));
    }
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return next(AppError.notFound("Registration not found"));
    }

    const registration = await Registration.findOne({ _id: req.params.id, tenantId }).lean();
    if (!registration) return next(AppError.notFound("Registration not found"));
    const state = studentVerificationState(registration);
    if (state === "not_required") {
      return next(new AppError("This registration has no student pricing claim to decide.", 409, "STUDENT_VERIFICATION_NOT_REQUIRED"));
    }
    if (state !== "pending") {
      return next(new AppError("This student pricing claim has already been decided.", 409, "STUDENT_VERIFICATION_ALREADY_DECIDED"));
    }

    const undecided = {
      _id: registration._id,
      tenantId,
      approvalStatus: "pending_review",
      "studentEligibility.verification.status": { $nin: ["verified", "rejected"] },
    };
    const existing = registration.studentEligibility || {};
    const decided = (status) => ({
      // A pre-policy portal row has no record: it is treated as an
      // undeclared claim (institution unknown) when decided.
      source: existing.source || "declared_claim",
      institution: existing.institution || null,
      declaredAt: existing.declaredAt || null,
      verification: { status, method: "crm", byUserId: req.ctx?.userId || null, at: new Date(), note: note || null },
    });
    const notPending = () =>
      new AppError(
        "This registration is no longer awaiting a student verification decision.",
        409,
        "STUDENT_VERIFICATION_ALREADY_DECIDED",
      );

    if (decision === "verify") {
      const updated = await Registration.findOneAndUpdate(
        undecided,
        { $set: { studentEligibility: decided("verified"), updatedBy: req.ctx?.userId || null } },
        { new: true },
      );
      if (!updated) return next(notPending());
      return res.status(200).json({ success: true, data: updated });
    }

    // reject: claim the registration first (same transient state approve/reject use).
    const claimed = await Registration.findOneAndUpdate(undecided, { $set: { approvalStatus: "processing" } }, { new: true });
    if (!claimed) return next(notPending());
    try {
      if (claimed.paymentMethod === "stripe") {
        if (claimed.stripePaymentIntentId) {
          await cancelPaymentIntent({ req, tenantId, paymentIntentId: claimed.stripePaymentIntentId });
        }
      } else if (claimed.paymentId) {
        await voidManualRegistrationPayment({ req, tenantId, paymentId: claimed.paymentId });
      }
    } catch (paymentError) {
      // Payment not released: leave the claim undecided and the registration pending.
      await Registration.updateOne(
        { _id: claimed._id, tenantId, approvalStatus: "processing" },
        { $set: { approvalStatus: "pending_review" } },
      ).catch(() => {});
      throw paymentError;
    }

    claimed.studentEligibility = decided("rejected");
    claimed.status = "cancelled";
    claimed.approvalStatus = "rejected";
    claimed.isActive = false;
    claimed.updatedBy = req.ctx?.userId || null;
    await claimed.save();
    await publishRegistrationCancelled(claimed, tenantId);
    return res.status(200).json({ success: true, data: claimed });
  } catch (error) {
    if (error instanceof AppError) return next(error);
    const status = error?.response?.status;
    return next(
      new AppError(
        "Failed to record the student verification decision",
        status && status >= 400 && status < 600 ? status : 502,
        "STUDENT_VERIFICATION_FAILED",
      ),
    );
  }
}

module.exports = { decideStudentVerification };
