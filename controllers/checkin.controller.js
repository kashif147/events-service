const mongoose = require("mongoose");
const Registration = require("../models/registration.model.js");
const EventSession = require("../models/eventSession.model.js");
const { AppError } = require("../errors/AppError.js");
const { signCheckinToken, verifyCheckinToken } = require("../services/checkinToken.service.js");

/**
 * Authenticated (CRM or the attendee's own portal session) - mints a QR/link
 * token for one registration+session, to be shown/printed/emailed for the
 * attendee to scan/click at the venue. Not itself an attendance record.
 */
async function getCheckinQr(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { id, sessionId } = req.params;

    const registration = await Registration.findOne({ _id: id, tenantId, isDeleted: { $ne: true } }).lean();
    if (!registration) return next(AppError.notFound("Registration not found"));
    const session = await EventSession.findOne({ _id: sessionId, tenantId, isDeleted: { $ne: true } }).lean();
    if (!session) return next(AppError.notFound("Session not found"));

    const token = signCheckinToken({ tenantId, registrationId: id, sessionId });
    return res.status(200).json({ success: true, data: { token } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to generate check-in token"));
  }
}

/**
 * Public (no auth) - the token itself is the credential. Atomically appends
 * an "attended" sessionAttendance entry, guarded on the sessionId not
 * already being present so a replayed/duplicate scan is a safe idempotent
 * no-op rather than a duplicate entry or an error (mirrors
 * registrationApproval.service.js's claimRegistrationForApproval atomic-guard
 * shape).
 */
async function selfCheckIn(req, res, next) {
  try {
    const decoded = verifyCheckinToken(req.params.token);
    if (!decoded) return next(AppError.badRequest("This check-in link is invalid or has expired"));
    const { tenantId, registrationId, sessionId } = decoded;

    const updated = await Registration.findOneAndUpdate(
      {
        _id: registrationId,
        tenantId,
        isActive: true,
        "sessionAttendance.sessionId": { $ne: new mongoose.Types.ObjectId(sessionId) },
      },
      {
        $push: {
          sessionAttendance: { sessionId, status: "attended", method: "qr", markedAt: new Date() },
        },
      },
      { new: true },
    );

    if (!updated) {
      // Either already checked in for this session (idempotent no-op, not an
      // error), or the registration is no longer active - either way, no new
      // write to make. Report success either way; a scanned QR is always the
      // attendee's own successful "you're checked in" screen.
      const existing = await Registration.findOne({ _id: registrationId, tenantId }).lean();
      if (!existing) return next(AppError.notFound("Registration not found"));
      return res.status(200).json({ success: true, data: { alreadyCheckedIn: true } });
    }

    return res.status(200).json({ success: true, data: { alreadyCheckedIn: false } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to check in"));
  }
}

/**
 * CRM manual mark/correction - can set or overwrite a session's attendance
 * record (unlike the QR path, this may legitimately need to fix a wrong
 * QR/Zoom result), so it's not append-only.
 */
async function markAttendanceCrm(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const { id, sessionId } = req.params;
    const { status } = req.body || {};
    if (!["attended", "absent"].includes(status)) {
      return next(AppError.badRequest("status must be 'attended' or 'absent'"));
    }

    const registration = await Registration.findOne({ _id: id, tenantId, isDeleted: { $ne: true } });
    if (!registration) return next(AppError.notFound("Registration not found"));

    const entry = { sessionId, status, method: "manual-crm", markedAt: new Date(), markedBy: userId || null };
    const existingIndex = registration.sessionAttendance.findIndex((a) => String(a.sessionId) === String(sessionId));
    if (existingIndex >= 0) {
      registration.sessionAttendance[existingIndex].set(entry);
    } else {
      registration.sessionAttendance.push(entry);
    }
    await registration.save();

    return res.status(200).json({ success: true, data: registration });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to mark attendance"));
  }
}

/**
 * Attendee self-service (authenticated portal/mobile, not the QR flow) -
 * can only mark themselves "attended", never "absent", and only for a
 * registration they actually submitted (submittedByUserId, the same
 * ownership check getMyRegistrations uses - see registration-flow.md).
 */
async function markAttendanceSelf(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const { id, sessionId } = req.params;

    const registration = await Registration.findOne({
      _id: id,
      tenantId,
      isDeleted: { $ne: true },
      submittedByUserId: userId,
    });
    if (!registration) return next(AppError.notFound("Registration not found"));

    const alreadyPresent = registration.sessionAttendance.some((a) => String(a.sessionId) === String(sessionId));
    if (!alreadyPresent) {
      registration.sessionAttendance.push({ sessionId, status: "attended", method: "manual-attendee", markedAt: new Date() });
      await registration.save();
    }

    return res.status(200).json({ success: true, data: registration });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to mark attendance"));
  }
}

module.exports = { getCheckinQr, selfCheckIn, markAttendanceCrm, markAttendanceSelf };
