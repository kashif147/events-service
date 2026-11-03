const { AppError } = require("../errors/AppError.js");
const { isUndergraduateStudentCategory } = require("./membershipCategory.util.js");

/**
 * P5 STUDENT pricing policy (server-enforced; the portal/CRM UI is not trusted).
 *
 * STUDENT pricing needs EITHER
 *   (a) the attendee's own verified active undergraduate-student membership, OR
 *   (b) an institution declaration that a CRM user explicitly verifies before
 *       approval / capture. Rejecting the claim rejects the registration (v1 -
 *       re-pricing is a separate, later flow).
 * GROUP_STUDENT is CRM-only until a group verification flow exists.
 * A membership lookup error is a 503, never "non-member" (subscriptionLookup.client.js).
 *
 * Recorded on Registration.studentEligibility (models/registration.model.js).
 */

const STUDENT_TIER_KEYS = ["STUDENT", "GROUP_STUDENT"];
const INSTITUTION_MAX = 200;

function isStudentPriced(registration) {
  if (!registration) return false;
  if (["student", "group_student"].includes(registration.priceCategory)) return true;
  return (registration.priceBreakdown || []).some((line) => STUDENT_TIER_KEYS.includes(line?.tierKey));
}

/**
 * Whether approval / capture must wait for (or is blocked by) a CRM decision.
 * Rows created before studentEligibility existed: CRM-created student pricing
 * was a staff decision (allowed); a portal/mobile student-priced row has no
 * recorded verification, so it needs one (fail closed).
 */
function studentVerificationState(registration) {
  if (!isStudentPriced(registration)) return "not_required";
  const eligibility = registration.studentEligibility;
  if (!eligibility) return registration.registeredVia === "crm" ? "verified" : "pending";
  const status = eligibility.verification?.status;
  return status === "verified" || status === "rejected" ? status : "pending";
}

/** Throws unless the registration's student pricing is resolved. Called before any capture / GL post. */
function assertStudentEligibilityResolved(registration) {
  const state = studentVerificationState(registration);
  if (state === "pending") {
    throw new AppError(
      "This registration's student pricing claim must be verified by a CRM user before it can be approved.",
      409,
      "STUDENT_VERIFICATION_PENDING",
    );
  }
  if (state === "rejected") {
    throw new AppError(
      "This registration's student pricing claim was rejected - it cannot be approved.",
      409,
      "STUDENT_CLAIM_REJECTED",
    );
  }
}

/** Trimmed, single-spaced, control-character-free institution name, or null. */
function normalizeInstitution(value) {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > INSTITUTION_MAX) return null;
  return cleaned;
}

/**
 * PORTAL caller: validates student tiers against the VERIFIED membership and
 * returns the studentEligibility record to store (null when no student tier
 * is used). `tierKeys` is [{ tierKey, quantity }] - the lineItems, or the
 * legacy path's single derived tier.
 */
function resolvePortalStudentEligibility({ tierLines, isActiveMember, membershipCategory, studentClaim, now = new Date() }) {
  const lines = tierLines || [];
  if (lines.some((line) => line.tierKey === "GROUP_STUDENT")) {
    throw new AppError(
      "Group student pricing is arranged by the organisation - it cannot be selected online.",
      403,
      "GROUP_STUDENT_CRM_ONLY",
    );
  }
  const studentLines = lines.filter((line) => line.tierKey === "STUDENT");
  if (!studentLines.length) return null;
  if (isActiveMember && isUndergraduateStudentCategory(membershipCategory)) {
    return {
      source: "verified_membership",
      institution: null,
      declaredAt: null,
      verification: { status: "verified", method: "membership", byUserId: null, at: now, note: null },
    };
  }
  if (isActiveMember) {
    throw new AppError(
      "STUDENT pricing is only available to non-members and undergraduate student members",
      400,
      "TIER_NOT_ELIGIBLE",
    );
  }
  const institution = normalizeInstitution(studentClaim?.institution);
  if (!institution) {
    throw new AppError(
      `Student pricing requires the name of your institution (2-${INSTITUTION_MAX} characters); it is verified before your registration is approved.`,
      400,
      "STUDENT_CLAIM_REQUIRED",
    );
  }
  return {
    source: "declared_claim",
    institution,
    declaredAt: now,
    verification: { status: "pending", method: null, byUserId: null, at: null, note: null },
  };
}

/** CRM caller chose a student tier: a staff decision, recorded with who made it. */
function crmStudentEligibility({ crmUserId, studentClaim, now = new Date() }) {
  return {
    source: "crm_assigned",
    institution: normalizeInstitution(studentClaim?.institution),
    declaredAt: null,
    verification: { status: "verified", method: "crm", byUserId: crmUserId || null, at: now, note: null },
  };
}

/**
 * Member-facing view of a registration's student claim (portal / self views). Only what the attendee
 * needs: where the student price came from, the institution they declared, and the verification
 * status. Never the verifier's user id, the verification method/time or the staff note (CRM-only).
 * Exact shape: { source, institution, verification: { status } } or null.
 */
const MEMBER_FACING_STUDENT_SOURCES = new Set(["verified_membership", "declared_claim", "crm_assigned"]);
function memberFacingStudentEligibility(eligibility) {
  if (!eligibility || typeof eligibility !== "object") return null;
  const source = MEMBER_FACING_STUDENT_SOURCES.has(eligibility.source) ? eligibility.source : null;
  if (!source) return null;
  return {
    source,
    institution: typeof eligibility.institution === "string" ? eligibility.institution : null,
    verification: { status: eligibility.verification?.status ?? null },
  };
}

/** Copy of a registration (lean object or mongoose document) with the member-facing claim view. */
function withMemberFacingStudentEligibility(registration) {
  if (!registration || typeof registration !== "object") return registration;
  const plain = typeof registration.toObject === "function" ? registration.toObject() : { ...registration };
  if (!Object.prototype.hasOwnProperty.call(plain, "studentEligibility")) return plain;
  return { ...plain, studentEligibility: memberFacingStudentEligibility(plain.studentEligibility) };
}

module.exports = {
  STUDENT_TIER_KEYS,
  isStudentPriced,
  studentVerificationState,
  assertStudentEligibilityResolved,
  normalizeInstitution,
  resolvePortalStudentEligibility,
  crmStudentEligibility,
  memberFacingStudentEligibility,
  withMemberFacingStudentEligibility,
};
