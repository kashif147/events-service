const {
  findProductByCode,
  createProduct,
  updateProduct,
  createPricing,
  getPricingByProduct,
  updatePricing,
} = require("./product.client");
const {
  resolveEventProductTypeId,
  INCOME_CODE_BY_CATEGORY,
  DEFAULT_INCOME_CODE,
  toProductDescription,
} = require("./eventProductLink.service");

function generateSessionProductCode(eventId, sessionId) {
  return `EVT-${String(eventId).slice(-12)}-S${String(sessionId).slice(-6)}`.toUpperCase();
}

/**
 * Per-day counterpart to eventProductLink.service.js's ensureEventProductLink -
 * same idempotent-by-code approach, but scoped to a single EventSession so
 * each day of a multi-day event can carry its own member/non-member price.
 */
async function ensureEventSessionProductLink(session, event, req, tenantId) {
  const productTypeId = await resolveEventProductTypeId(event, req, tenantId);
  const incomeAccountCode = INCOME_CODE_BY_CATEGORY[event.eventCategoryCode] || DEFAULT_INCOME_CODE;
  const code = generateSessionProductCode(event._id, session._id);

  const productFields = {
    name: `${event.title} — ${session.label}`,
    description: toProductDescription(event.description),
    productTypeId,
    incomeAccountCode,
  };

  let product = await findProductByCode(req, tenantId, code);
  if (product) {
    product = await updateProduct(req, tenantId, product._id, productFields);
  } else {
    product = await createProduct(req, tenantId, { ...productFields, code });
  }

  const pricingFields = {
    memberPrice: session.memberPrice,
    nonMemberPrice: session.nonMemberPrice,
    effectiveFrom: session.date,
    effectiveTo: session.date,
  };

  const existingPricing = (await getPricingByProduct(req, tenantId, product._id))[0];
  if (existingPricing) {
    await updatePricing(req, tenantId, existingPricing._id, pricingFields);
  } else {
    await createPricing(req, tenantId, { productId: product._id, currency: "EUR", ...pricingFields });
  }

  return { productId: product._id, productCode: product.code };
}

/** Push an already-linked session's current fields onto its existing Product + Pricing. */
async function syncEventSessionProductLink(session, event, req, tenantId) {
  const productTypeId = await resolveEventProductTypeId(event, req, tenantId);
  const incomeAccountCode = INCOME_CODE_BY_CATEGORY[event.eventCategoryCode] || DEFAULT_INCOME_CODE;

  await updateProduct(req, tenantId, session.productId, {
    name: `${event.title} — ${session.label}`,
    description: toProductDescription(event.description),
    productTypeId,
    incomeAccountCode,
  });

  const pricingRecords = await getPricingByProduct(req, tenantId, session.productId);
  const currentPricing = pricingRecords[0];
  if (!currentPricing) {
    throw new Error(`No Pricing record found for product ${session.productId} to sync`);
  }

  await updatePricing(req, tenantId, currentPricing._id, {
    memberPrice: session.memberPrice,
    nonMemberPrice: session.nonMemberPrice,
    effectiveFrom: session.date,
    effectiveTo: session.date,
  });
}

module.exports = { ensureEventSessionProductLink, syncEventSessionProductLink };
