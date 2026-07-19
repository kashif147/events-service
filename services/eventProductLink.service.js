const {
  resolveProductTypeId,
  createProduct,
  updateProduct,
  createPricing,
  getPricingByProduct,
  updatePricing,
} = require("./product.client");

// Static per-category GL income codes (see backend/account-service/scripts/seed-cpd-events-income-coa.js).
// Keyed by the real ProductType codes in Product Management (confirmed via
// GET /api/product-types - "CPD" and "EVENT", not assumed/guessed strings).
// Falls back to the shared default (4500, see account-service's
// eventRegistration.approval.listener.js) for any other category, so a new
// non-Membership ProductType the admin adds later degrades safely instead
// of failing, until its own income code is added here.
const INCOME_CODE_BY_CATEGORY = {
  EVENT: "4520",
  CPD: "4510",
};
const DEFAULT_INCOME_CODE = "4500";

// The Event carries the real ProductType _id the admin picked (set by the
// frontend, which fetches actual ProductTypes rather than assuming a fixed
// code exists) - use that directly. Only fall back to resolving by code for
// events saved before eventCategoryProductTypeId existed.
async function resolveEventProductTypeId(event, req, tenantId) {
  if (event.eventCategoryProductTypeId) return event.eventCategoryProductTypeId;
  return resolveProductTypeId(req, tenantId, event.eventCategoryCode);
}

function generateProductCode(eventId) {
  return `EVT-${String(eventId).slice(-12)}`.toUpperCase();
}

// user-service's Product.description caps at 500 chars, but the event
// description is rich HTML from the Quill editor - all the markup/inline
// styles push it well past that even for a short write-up. Collapse it to a
// short plain-text summary instead of sending the raw HTML and hitting the
// same "longer than the maximum allowed length" validation error every time.
const PRODUCT_DESCRIPTION_MAX_LENGTH = 4000;
function toProductDescription(html) {
  if (!html) return undefined;
  const plain = String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length <= PRODUCT_DESCRIPTION_MAX_LENGTH
    ? plain
    : `${plain.slice(0, PRODUCT_DESCRIPTION_MAX_LENGTH - 1)}…`;
}

function toDateOnly(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Single-day event -> effectiveFrom === effectiveTo === the event date.
// Multi-day event -> effectiveFrom = startDate, effectiveTo = the last day (endDate).
function resolveEffectiveDates(event) {
  const effectiveFrom = event.startDate;
  const endDate = event.endDate || event.startDate;
  const isSameDay = toDateOnly(event.startDate) === toDateOnly(endDate);
  return { effectiveFrom, effectiveTo: isSameDay ? event.startDate : endDate };
}

/** Create a new Product + Pricing for an event that has no linked productId yet. */
async function ensureEventProductLink(event, req, tenantId) {
  const productTypeId = await resolveEventProductTypeId(event, req, tenantId);
  const incomeAccountCode = INCOME_CODE_BY_CATEGORY[event.eventCategoryCode] || DEFAULT_INCOME_CODE;
  const { effectiveFrom, effectiveTo } = resolveEffectiveDates(event);

  const product = await createProduct(req, tenantId, {
    name: event.title,
    code: generateProductCode(event._id),
    description: toProductDescription(event.description),
    productTypeId,
    incomeAccountCode,
  });

  await createPricing(req, tenantId, {
    productId: product._id,
    currency: "EUR",
    memberPrice: event.memberPrice,
    nonMemberPrice: event.nonMemberPrice,
    effectiveFrom,
    effectiveTo,
  });

  return { productId: product._id, productCode: product.code };
}

/** Push an already-linked event's current fields onto its existing Product + Pricing. */
async function syncEventProductLink(event, req, tenantId) {
  const productTypeId = await resolveEventProductTypeId(event, req, tenantId);
  const incomeAccountCode = INCOME_CODE_BY_CATEGORY[event.eventCategoryCode] || DEFAULT_INCOME_CODE;

  await updateProduct(req, tenantId, event.productId, {
    name: event.title,
    description: toProductDescription(event.description),
    productTypeId,
    incomeAccountCode,
  });

  const pricingRecords = await getPricingByProduct(req, tenantId, event.productId);
  const currentPricing = pricingRecords[0];
  if (!currentPricing) {
    throw new Error(`No Pricing record found for product ${event.productId} to sync`);
  }

  const { effectiveFrom, effectiveTo } = resolveEffectiveDates(event);
  await updatePricing(req, tenantId, currentPricing._id, {
    memberPrice: event.memberPrice,
    nonMemberPrice: event.nonMemberPrice,
    effectiveFrom,
    effectiveTo,
  });
}

module.exports = { ensureEventProductLink, syncEventProductLink };
