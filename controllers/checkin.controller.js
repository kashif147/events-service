const mongoose = require("mongoose");
const Registration = require("../models/registration.model.js");
const { AppError } = require("../errors/AppError.js");
const {
  ownerScopedRegistrationQuery,
  isPortalOwnerScoped,
  denyNotOwner,
} = require("../middlewares/callerClass.mw.js");
const { signCheckinToken, verifyCheckinToken } = require("../services/checkinToken.service.js");
const {
  validateAttendanceIds,
  attendanceTargetError,
  loadRegistrationSession,
  checkAttendeeAttendance,
} = require("../services/attendanceEligibility.service.js");

/**
 * Authenticated (CRM or the attendee's own portal session) - mints a QR/link
 * token for one registration+session, to be shown/printed/emailed for the
 * attendee to scan/click at the venue. Not itself an attendance record, but
 * it IS a credential for one, so it gets the same structural checks as the
 * self route: eligible registration, session of the registration's own event
 * in the verified tenant, selected session for partial attendance.
 */
async function getCheckinQr(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const { id, sessionId } = req.params;

    const idError = validateAttendanceIds({ registrationId: id, sessionId });
    if (idError) return next(idError);

    const registration = await Registration.findOne(
      ownerScopedRegistrationQuery(req, { _id: id, tenantId, isDeleted: { $ne: true } }),
    ).lean();
    if (!registration) {
      if (isPortalOwnerScoped(req)) return denyNotOwner(res);
      return next(AppError.notFound("Registration not found"));
    }

    const { error } = await checkAttendeeAttendance({ tenantId, registration, sessionId });
    if (error) return next(error);

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
 *
 * The token's registration/session pairing is re-validated at redemption
 * (not only at minting): a token minted before a registration was
 * cancelled/rejected, or for a session that has since been deleted, must not
 * write an entry.
 */
async function selfCheckIn(req, res, next) {
  try {
    const decoded = verifyCheckinToken(req.params.token);
    if (!decoded) return next(AppError.badRequest("This check-in link is invalid or has expired"));
    const { tenantId, registrationId, sessionId } = decoded;
    if (validateAttendanceIds({ registrationId, sessionId })) {
      return next(AppError.badRequest("This check-in link is invalid or has expired"));
    }
    const sessionObjectId = new mongoose.Types.ObjectId(sessionId);

    const registration = await Registration.findOne({
      _id: registrationId,
      tenantId,
      isDeleted: { $ne: true },
    }).lean();
    if (!registration) return next(AppError.notFound("Registration not found"));

    // Already has an entry for this session (any method/status) - idempotent
    // no-op, never a second entry or an overwrite of a CRM decision.
    const alreadyPresent = (registration.sessionAttendance || []).some(
      (a) => String(a.sessionId) === String(sessionId),
    );
    if (alreadyPresent) return res.status(200).json({ success: true, data: { alreadyCheckedIn: true } });

    const { error } = await checkAttendeeAttendance({ tenantId, registration, sessionId });
    if (error) return next(error);

    const updated = await Registration.findOneAndUpdate(
      {
        _id: registrationId,
        tenantId,
        isDeleted: { $ne: true },
        isActive: true,
        status: "confirmed",
        approvalStatus: "approved",
        "sessionAttendance.sessionId": { $ne: sessionObjectId },
      },
      {
        $push: {
          sessionAttendance: { sessionId: sessionObjectId, status: "attended", method: "qr", markedAt: new Date() },
        },
      },
      { new: true },
    );

    if (!updated) {
      // Lost a race: either a concurrent scan already wrote the entry
      // (idempotent no-op) or the registration changed state in between.
      const fresh = await Registration.findOne({ _id: registrationId, tenantId }).lean();
      const nowPresent = (fresh?.sessionAttendance || []).some((a) => String(a.sessionId) === String(sessionId));
      if (nowPresent) return res.status(200).json({ success: true, data: { alreadyCheckedIn: true } });
      return next(new AppError("This registration is not eligible for attendance", 409, "REGISTRATION_NOT_ELIGIBLE"));
    }

    return res.status(200).json({ success: true, data: { alreadyCheckedIn: false } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to check in"));
  }
}

/**
 * CRM manual mark/correction - can set or overwrite a session's attendance
 * record (unlike the QR path, this may legitimately need to fix a wrong
 * QR/Zoom result), so it's not append-only. Staff corrections are allowed in
 * any registration state (e.g. fixing a no-show after the rollup), but the
 * session must be a session of the registration's own event in the tenant.
 */
async function markAttendanceCrm(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const { id, sessionId } = req.params;
    const { status } = req.body || {};
    if (!["attended", "absent"].includes(status)) {
      return next(AppError.badRequest("status must be 'attended' or 'absent'"));
    }
    const idError = validateAttendanceIds({ registrationId: id, sessionId });
    if (idError) return next(idError);

    const registration = await Registration.findOne({ _id: id, tenantId, isDeleted: { $ne: true } });
    if (!registration) return next(AppError.notFound("Registration not found"));

    const targetError = attendanceTargetError(registration);
    if (targetError) return next(targetError);
    const { error } = await loadRegistrationSession({ tenantId, registration, sessionId });
    if (error) return next(error);

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
 * PORTAL-only (route gate requirePortalUser; CRM records attendance through
 * PUT .../attendance so a staff action is stored as manual-crm with
 * markedBy, never as a manual-attendee self-attestation). Can only mark
 * "attended", never "absent", and only for a registration the verified
 * caller submitted (submittedByUserId, the same binding GET /mine uses).
 * Any ownership miss - other member, other tenant, nonexistent - is the same
 * 403 NOT_OWNER (no existence probe).
 *
 * NOTE: no attendance time window yet (product decision pending) - an
 * eligible attendee can still self-mark one of their own sessions at any
 * time. This is an open certificate-integrity risk until a window is agreed.
 */
async function markAttendanceSelf(req, res, next) {
  try {
    const { tenantId } = req.ctx;
    const ownerUserId = req.verifiedCaller?.userId;
    const { id, sessionId } = req.params;
    if (!ownerUserId) return denyNotOwner(res);

    const idError = validateAttendanceIds({ registrationId: id, sessionId });
    if (idError) return next(idError);

    const registration = await Registration.findOne({
      _id: id,
      tenantId,
      isDeleted: { $ne: true },
      submittedByUserId: ownerUserId,
    });
    if (!registration) return denyNotOwner(res);

    const { error } = await checkAttendeeAttendance({ tenantId, registration, sessionId });
    if (error) return next(error);

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
