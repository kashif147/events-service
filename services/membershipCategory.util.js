// Mirrors account-service's src/helpers/noFeeMembershipCategory.js matching
// rule (that file is an ES module in a different service - this is the
// CommonJS equivalent for events-service's pricing resolution).
function normalizeMembershipCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isUndergraduateStudentCategory(value) {
  const key = normalizeMembershipCategoryKey(value);
  if (!key) return false;
  return key.includes("undergraduate") && key.includes("student") && !key.includes("postgraduate");
}

module.exports = { normalizeMembershipCategoryKey, isUndergraduateStudentCategory };
