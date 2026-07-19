const {
  resolveProductTypeId,
  createProduct,
  updateProduct,
  createPricing,
  getPricingByProduct,
  updatePricing,
} = require("./product.client");

// Static per-category GL income codes (see backend/account-service/scripts/seed-cpd-events-income-coa.js).
// Falls back to the shared default (4500, see account-service's
// eventRegistration.approval.listener.js) for any category code that isn't
// one of these two recognized ones.
const INCOME_CODE_BY_CATEGORY = {
  EVENTS: "4520",
  CONTINUOUS_PROFESSIONAL_DEVELOPMENT: "4510",
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
    description: event.description || undefined,
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
    description: event.description || undefined,
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
