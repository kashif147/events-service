const Course = require("../models/course.model.js");
const Event = require("../models/event.model.js");
const EventSession = require("../models/eventSession.model.js");
const { AppError } = require("../errors/AppError.js");
const { getCurrentPriceForProduct } = require("./pricing.client.js");
const { isUndergraduateStudentCategory } = require("./membershipCategory.util.js");

/**
 * Resolve the per-person price (in euros) for a single Event or EventSession
 * document - both share the memberPrice/nonMemberPrice/pricingTiers shape.
 * Returns { price, appliedTier } - appliedTier names which specific tier was
 * actually used (STUDENT, GROUP_STUDENT, EARLY_BIRD_MEMBER,
 * EARLY_BIRD_NON_MEMBER, MEMBER or NON_MEMBER), for display purposes.
 * Throws AppError.badRequest if the requested priceCategory isn't available
 * on the entity, or (for group_student) if quantity doesn't meet the
 * minimum group size.
 */
function resolveUnitPriceForEntity({ entity, entityLabel, isMember, priceCategory, quantity, now }) {
  const tiers = Array.isArray(entity.pricingTiers) ? entity.pricingTiers : [];
  const activeTierOfType = (tierType) =>
    tiers.find((t) => t.tierType === tierType && t.isActive !== false);

  if (priceCategory === "student") {
    const tier = activeTierOfType("STUDENT");
    if (!tier) throw AppError.badRequest(`Student pricing is not available for ${entityLabel}`);
    return { price: tier.price, appliedTier: "STUDENT" };
  }

  if (priceCategory === "group_student") {
    const tier = activeTierOfType("GROUP_STUDENT");
    if (!tier) throw AppError.badRequest(`Group student pricing is not available for ${entityLabel}`);
    const minSize = tier.minGroupSize || 2;
    if (quantity < minSize) {
      throw AppError.badRequest(
        `Group student pricing for ${entityLabel} requires at least ${minSize} seat(s) in this registration (you have ${quantity})`,
      );
    }
    return { price: tier.price, appliedTier: "GROUP_STUDENT" }; // per-person - caller multiplies by quantity
  }

  // "standard": early bird (if within cutoff) else the base price.
  const earlyBirdType = isMember ? "EARLY_BIRD_MEMBER" : "EARLY_BIRD_NON_MEMBER";
  const earlyBird = activeTierOfType(earlyBirdType);
  if (earlyBird && earlyBird.cutoffDate && now <= new Date(earlyBird.cutoffDate)) {
    return { price: earlyBird.price, appliedTier: earlyBirdType };
  }
  return {
    price: (isMember ? entity.memberPrice : entity.nonMemberPrice) || 0,
    appliedTier: isMember ? "MEMBER" : "NON_MEMBER",
  };
}

/**
 * Auto-derive which pricing tier an attendee qualifies for, from their real
 * (verified) membership status/category rather than a self-declared choice:
 * - active membership + an undergraduate-student category -> "student", or
 *   "group_student" once quantity meets the event's configured minimum.
 * - anything else (active non-student member, lapsed/no membership) ->
 *   "standard", which resolveUnitPriceForEntity resolves to early-bird or
 *   base member/non-member pricing automatically.
 * Falls through to "standard" when the qualifying tier isn't configured on
 * the event, so an event with no STUDENT tier still prices sensibly.
 */
function determinePriceCategory({ isActiveMember, membershipCategory, quantity, entity }) {
  if (!isActiveMember || !isUndergraduateStudentCategory(membershipCategory)) {
    return "standard";
  }

  const tiers = Array.isArray(entity?.pricingTiers) ? entity.pricingTiers : [];
  const groupStudentTier = tiers.find((t) => t.tierType === "GROUP_STUDENT" && t.isActive !== false);
  if (groupStudentTier && quantity >= (groupStudentTier.minGroupSize || 2)) {
    return "group_student";
  }

  const studentTier = tiers.find((t) => t.tierType === "STUDENT" && t.isActive !== false);
  if (studentTier) return "student";

  return "standard";
}

async function resolveAmount({
  tenantId,
  registrationType,
  eventId,
  courseId,
  sessionIds,
  isMember,
  priceCategory = "standard",
  quantity = 1,
}) {
  if (registrationType === "course") {
    const course = await Course.findOne({ _id: courseId, tenantId }).lean();
    if (!course) throw AppError.notFound("Course not found");
    const { amount, currency } = await getCurrentPriceForProduct(course.productId, { isMember });
    // Courses have no Event Category equivalent yet - account-service falls
    // back to its default GL income code when eventCategoryCode is null.
    return { amount: amount * quantity, currency, productCode: course.productCode || null, eventCategoryCode: null };
  }

  const event = await Event.findOne({ _id: eventId, tenantId }).lean();
  if (!event) throw AppError.notFound("Event not found");
  const now = new Date();

  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    const sessions = await EventSession.find({
      _id: { $in: sessionIds },
      tenantId,
      eventId,
    }).lean();
    let amount = 0;
    for (const session of sessions) {
      // A session with no price/tiers of its own (per-day pricing off, or
      // this particular day left at the event's default) prices at the
      // event's own rate instead of silently coming out as 0.
      const hasOwnPricing =
        session.memberPrice != null ||
        session.nonMemberPrice != null ||
        (Array.isArray(session.pricingTiers) && session.pricingTiers.length > 0);
      const priceEntity = hasOwnPricing ? session : event;
      const { price: unitPriceEuros } = resolveUnitPriceForEntity({
        entity: priceEntity,
        entityLabel: session.label || event.title,
        isMember,
        priceCategory,
        quantity,
        now,
      });
      amount += Math.round(unitPriceEuros * 100);
    }
    return {
      amount: amount * quantity,
      currency: "eur",
      productCode: event.productCode || null,
      eventCategoryCode: event.eventCategoryLookupCode || null,
    };
  }

  const { price: unitPriceEuros } = resolveUnitPriceForEntity({
    entity: event,
    entityLabel: event.title,
    isMember,
    priceCategory,
    quantity,
    now,
  });
  return {
    amount: Math.round(unitPriceEuros * 100) * quantity,
    currency: "eur",
    productCode: event.productCode || null,
    eventCategoryCode: event.eventCategoryLookupCode || null,
  };
}

module.exports = { resolveUnitPriceForEntity, determinePriceCategory, resolveAmount };
