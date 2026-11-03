const mongoose = require("mongoose");
const Registration = require("../models/registration.model.js");
const Certificate = require("../models/certificate.model.js");
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
  correctionWindowContext,
} = require("../services/attendanceEligibility.service.js");
const { PATHS } = require("../services/attendanceWindow.service.js");
const { withTransaction } = require("../services/transaction.js");
const { ROUTING_KEYS, enqueueAudit } = require("../services/attendanceAudit.service.js");

const ELIGIBLE_FILTER = {
  isDeleted: { $ne: true },
  isActive: true,
  status: "confirmed",
  approvalStatus: "approved",
};
const REASON_MAX = 500;

function hasEntry(registration, sessionId) {
  return (registration.sessionAttendance || []).some((a) => String(a.sessionId) === String(sessionId));
}

/**
 * Authenticated (CRM, or the attendee's own portal session) - mints a check-in pass for one
 * registration+session, to be SHOWN TO THE ORGANISER, who scans it (scanCheckinToken). Holding a
 * pass never records attendance by itself. Same structural checks as every attendee path; may be
 * minted before the window opens, never after it closes; expires when the QR window closes.
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

    const { error, window } = await checkAttendeeAttendance({ tenantId, registration, sessionId, path: PATHS.QR_MINT });
    if (error) return next(error);

    const token = signCheckinToken({ tenantId, registrationId: id, sessionId, expiresAt: window.closesAt });
    return res.status(200).json({
      success: true,
      data: { token, opensAt: window.opensAt.toISOString(), expiresAt: window.closesAt.toISOString() },
    });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to generate check-in token"));
  }
}

/**
 * Organiser scan (CRM + events:write, route-gated). The pass is only evidence of WHICH booking is
 * presenting; the authenticated organiser in the same tenant is what records presence. Re-runs every
 * structural check and the QR window at scan time, appends a "qr-organizer" entry atomically (a
 * second scan of the same session is an idempotent no-op), and returns only what the organiser
 * needs to confirm the person in front of them.
 */
async function scanCheckinToken(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const decoded = verifyCheckinToken(req.body?.token);
    if (!decoded) return next(new AppError("This check-in pass is invalid or has expired", 400, "CHECKIN_PASS_INVALID"));
    if (String(decoded.tenantId) !== String(tenantId)) {
      return next(new AppError("This check-in pass belongs to another organisation", 403, "CHECKIN_TENANT_MISMATCH"));
    }
    const { registrationId, sessionId } = decoded;
    if (validateAttendanceIds({ registrationId, sessionId })) {
      return next(new AppError("This check-in pass is invalid or has expired", 400, "CHECKIN_PASS_INVALID"));
    }

    const registration = await Registration.findOne({ _id: registrationId, tenantId, isDeleted: { $ne: true } }).lean();
    if (!registration) return next(AppError.notFound("Registration not found"));

    const result = {
      attendee: {
        firstName: registration.attendeeSnapshot?.firstName || null,
        lastName: registration.attendeeSnapshot?.lastName || null,
      },
    };
    if (hasEntry(registration, sessionId)) {
      return res.status(200).json({ success: true, data: { ...result, alreadyCheckedIn: true } });
    }

    const { error, session } = await checkAttendeeAttendance({ tenantId, registration, sessionId, path: PATHS.QR_SCAN });
    if (error) return next(error);
    result.session = { id: String(session._id), label: session.label };

    const sessionObjectId = new mongoose.Types.ObjectId(sessionId);
    const updated = await Registration.findOneAndUpdate(
      { _id: registrationId, tenantId, ...ELIGIBLE_FILTER, "sessionAttendance.sessionId": { $ne: sessionObjectId } },
      {
        $push: {
          sessionAttendance: {
            sessionId: sessionObjectId,
            status: "attended",
            method: "qr-organizer",
            markedAt: new Date(),
            scannedBy: userId || null,
          },
        },
      },
      { new: true },
    );
    if (!updated) {
      const fresh = await Registration.findOne({ _id: registrationId, tenantId }).lean();
      if (fresh && hasEntry(fresh, sessionId)) {
        return res.status(200).json({ success: true, data: { ...result, alreadyCheckedIn: true } });
      }
      return next(new AppError("This registration is not eligible for attendance", 409, "REGISTRATION_NOT_ELIGIBLE"));
    }
    return res.status(200).json({ success: true, data: { ...result, alreadyCheckedIn: false } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to record check-in"));
  }
}

/**
 * Public (unauthenticated) landing for a pass link: informational only - it never verifies the pass
 * against data and never writes attendance.
 */
function publicCheckinInfo(req, res) {
  return res.status(200).json({
    success: true,
    data: {
      message: "Show this check-in pass to the event organiser. Attendance is recorded when the organiser scans it.",
    },
  });
}

/**
 * Retired public redemption (P5). A pass alone is not proof of presence; attendance is recorded only
 * by an authenticated organiser scan. 410, no write.
 */
function retiredPublicCheckIn(req, res) {
  return res.status(410).json({
    success: false,
    error: {
      message: "Self check-in links are no longer supported - please show your check-in pass to the event organiser",
      code: "CHECKIN_LINK_RETIRED",
      status: 410,
    },
  });
}

/**
 * CRM manual mark/correction (CRM + events:write). Can set or overwrite a session's attendance
 * entry in any registration state, but:
 *   - a `reason` is required when the correction is outside the session's QR window (or the window
 *     is unavailable) or overwrites an existing entry; the overwritten entry is kept in `previous`;
 *   - the write is conditional on the entry it read (a concurrent change -> 409, nothing written);
 *   - attended -> absent on a registration with an ISSUED certificate flags that certificate for
 *     review (never revoked, status unchanged);
 *   - every correction is audited through the transactional outbox, in the same transaction.
 */
async function markAttendanceCrm(req, res, next) {
  try {
    const { tenantId, userId } = req.ctx;
    const { id, sessionId } = req.params;
    const { status } = req.body || {};
    const rawReason = req.body?.reason;
    if (!["attended", "absent"].includes(status)) {
      return next(AppError.badRequest("status must be 'attended' or 'absent'"));
    }
    if (rawReason != null && (typeof rawReason !== "string" || rawReason.length > REASON_MAX)) {
      return next(new AppError(`reason must be text of at most ${REASON_MAX} characters`, 400, "INVALID_REASON"));
    }
    const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim() : null;
    const idError = validateAttendanceIds({ registrationId: id, sessionId });
    if (idError) return next(idError);

    const registration = await Registration.findOne({ _id: id, tenantId, isDeleted: { $ne: true } }).lean();
    if (!registration) return next(AppError.notFound("Registration not found"));

    const targetError = attendanceTargetError(registration);
    if (targetError) return next(targetError);
    const { session, error } = await loadRegistrationSession({ tenantId, registration, sessionId });
    if (error) return next(error);

    const existing = (registration.sessionAttendance || []).find((a) => String(a.sessionId) === String(sessionId)) || null;
    const { outsideWindow } = await correctionWindowContext({ tenantId, registration, session });
    if ((outsideWindow || existing) && !reason) {
      return next(
        new AppError(
          existing
            ? "A reason is required to change an existing attendance record"
            : "A reason is required to record attendance outside the session's check-in window",
          400,
          "CORRECTION_REASON_REQUIRED",
        ),
      );
    }

    const sessionObjectId = new mongoose.Types.ObjectId(sessionId);
    const now = new Date();
    const previous = existing
      ? { status: existing.status, method: existing.method, markedAt: existing.markedAt || null, markedBy: existing.markedBy || null }
      : null;
    const entry = {
      sessionId: sessionObjectId,
      status,
      method: "manual-crm",
      markedAt: now,
      markedBy: userId || null,
      reason,
      outsideWindow,
      previous,
    };
    const downgrade = previous?.status === "attended" && status === "absent";

    const outcome = await withTransaction(async (txn) => {
      let updated;
      if (existing) {
        updated = await Registration.findOneAndUpdate(
          {
            _id: id,
            tenantId,
            isDeleted: { $ne: true },
            sessionAttendance: {
              $elemMatch: { sessionId: sessionObjectId, status: existing.status, method: existing.method, markedAt: existing.markedAt },
            },
          },
          { $set: { "sessionAttendance.$": entry } },
          { new: true, session: txn },
        );
      } else {
        updated = await Registration.findOneAndUpdate(
          { _id: id, tenantId, isDeleted: { $ne: true }, "sessionAttendance.sessionId": { $ne: sessionObjectId } },
          { $push: { sessionAttendance: entry } },
          { new: true, session: txn },
        );
      }
      if (!updated) return { conflict: true };

      let flaggedCertificateId = null;
      if (downgrade) {
        const cert = await Certificate.findOneAndUpdate(
          { tenantId, registrationId: id, status: "issued", reviewRequired: { $ne: true } },
          { $set: { reviewRequired: true, reviewReason: "ATTENDANCE_DOWNGRADED", reviewFlaggedAt: now, reviewFlaggedBy: userId || null } },
          { new: true, session: txn },
        );
        if (cert) flaggedCertificateId = String(cert._id);
      }

      await enqueueAudit(
        ROUTING_KEYS.ATTENDANCE_CORRECTED,
        "att-corr",
        tenantId,
        {
          registrationId: String(id),
          eventId: String(registration.eventId),
          sessionId: String(sessionId),
          from: previous,
          to: { status, method: "manual-crm" },
          reason,
          outsideWindow,
          actorUserId: userId || null,
          occurredAt: now.toISOString(),
        },
        { session: txn, correlationId: req.correlationId },
      );
      if (flaggedCertificateId) {
        await enqueueAudit(
          ROUTING_KEYS.CERTIFICATE_REVIEW_FLAGGED,
          "cert-review",
          tenantId,
          {
            certificateId: flaggedCertificateId,
            registrationId: String(id),
            sessionId: String(sessionId),
            reviewReason: "ATTENDANCE_DOWNGRADED",
            actorUserId: userId || null,
            occurredAt: now.toISOString(),
          },
          { session: txn, correlationId: req.correlationId },
        );
      }
      return { updated, flaggedCertificateId };
    });

    if (outcome.conflict) {
      return next(new AppError("The attendance record changed while you were editing it - reload and try again", 409, "ATTENDANCE_CHANGED_CONCURRENTLY"));
    }
    return res.status(200).json({
      success: true,
      data: outcome.updated,
      ...(outcome.flaggedCertificateId ? { certificateReviewFlagged: outcome.flaggedCertificateId } : {}),
    });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to mark attendance"));
  }
}

/**
 * Attendee self-service (PORTAL only, route-gated) - VIRTUAL sessions only, inside the self window
 * (opens start-30 min, closes end+15 min). In-person attendance is recorded by the organiser scan.
 * Only for a registration the verified caller submitted; any ownership miss is the same 403
 * NOT_OWNER. An attendee who already has an entry gets 200 regardless of the window.
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
    }).lean();
    if (!registration) return denyNotOwner(res);
    if (hasEntry(registration, sessionId)) {
      return res.status(200).json({ success: true, data: { alreadyCheckedIn: true } });
    }

    const { error } = await checkAttendeeAttendance({ tenantId, registration, sessionId, path: PATHS.SELF });
    if (error) return next(error);

    const sessionObjectId = new mongoose.Types.ObjectId(sessionId);
    const updated = await Registration.findOneAndUpdate(
      {
        _id: id,
        tenantId,
        submittedByUserId: ownerUserId,
        ...ELIGIBLE_FILTER,
        "sessionAttendance.sessionId": { $ne: sessionObjectId },
      },
      {
        $push: {
          sessionAttendance: { sessionId: sessionObjectId, status: "attended", method: "manual-attendee", markedAt: new Date() },
        },
      },
      { new: true },
    );
    if (!updated) {
      const fresh = await Registration.findOne({ _id: id, tenantId }).lean();
      if (fresh && hasEntry(fresh, sessionId)) return res.status(200).json({ success: true, data: { alreadyCheckedIn: true } });
      return next(new AppError("This registration is not eligible for attendance", 409, "REGISTRATION_NOT_ELIGIBLE"));
    }
    return res.status(200).json({ success: true, data: { alreadyCheckedIn: false } });
  } catch (error) {
    return next(AppError.internalServerError(error.message || "Failed to mark attendance"));
  }
}

module.exports = {
  getCheckinQr,
  scanCheckinToken,
  publicCheckinInfo,
  retiredPublicCheckIn,
  markAttendanceCrm,
  markAttendanceSelf,
};
