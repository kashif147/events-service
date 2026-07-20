const eventTemplateService = require("../services/eventTemplate.service");
const { AppError } = require("../errors/AppError");
const {
  validateCreateEventTemplate,
  validateUpdateEventTemplate,
} = require("../validators/eventTemplate.validators");

function normalizeRoleValue(role) {
  if (!role) return "";
  const raw =
    typeof role === "string"
      ? role
      : role.code || role.name || role.roleCode || role.roleName || "";
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function canEditSystemDefaultTemplate(req) {
  const roles = Array.isArray(req.ctx?.roles)
    ? req.ctx.roles
    : Array.isArray(req.roles)
      ? req.roles
      : [];
  const normalizedRoles = roles.map(normalizeRoleValue).filter(Boolean);
  return normalizedRoles.some((role) =>
    [
      "su",
      "asu",
      "super user",
      "assistant super user",
      "system admin",
      "system administrator",
      "superuser",
      "assistantsuperuser",
      "systemadmin",
    ].includes(role),
  );
}

function isSystemDefaultPreferenceOnlyUpdate(payload = {}) {
  const keys = Object.keys(payload || {}).filter((key) => payload[key] !== undefined);
  if (keys.length === 0) return false;
  return keys.every((key) => key === "isDefault" || key === "pinned");
}

function requestContext(req) {
  const creatorId = req.ctx?.userId || req.userId || req.user?.id || req.user?.sub || null;
  const tenantId = req.ctx?.tenantId || req.tenantId || null;
  return { userType: req.user?.userType, creatorId, tenantId };
}

function assertCrmUser(req, next) {
  const { userType } = requestContext(req);
  if (userType !== "CRM") {
    next(AppError.forbidden("Access denied. Only CRM users can manage Events filter templates."));
    return false;
  }
  return true;
}

exports.createTemplate = async (req, res, next) => {
  try {
    if (!assertCrmUser(req, next)) return;
    const { creatorId, tenantId } = requestContext(req);

    const validatedData = validateCreateEventTemplate(req.body);
    const template = await eventTemplateService.createTemplate(creatorId, validatedData, tenantId);

    return res.status(201).json({
      success: true,
      data: template,
      message: "Filter template created successfully",
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * List templates for the current user. Query param: type (default eventssummary).
 * Response: total + templates (systemDefault, userTemplates).
 */
exports.getUserTemplates = async (req, res, next) => {
  try {
    if (!assertCrmUser(req, next)) return;
    const { creatorId, tenantId } = requestContext(req);

    const type = req.query.type || "eventssummary";
    const list = await eventTemplateService.getUserTemplatesWithSystemDefault(
      creatorId,
      type,
      tenantId,
    );

    const systemDefault = list.find((t) => t.systemDefault) || null;
    const userTemplates = list.filter((t) => !t.systemDefault);
    const userHasDefault = userTemplates.some((t) => t.isDefault);
    if (systemDefault && !userHasDefault) {
      systemDefault.isDefault = true;
    }

    return res.status(200).json({
      success: true,
      data: {
        total: list.length,
        templates: { systemDefault, userTemplates },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.getTemplateById = async (req, res, next) => {
  try {
    if (!assertCrmUser(req, next)) return;
    const { creatorId, tenantId } = requestContext(req);
    const { templateId } = req.params;

    const template = await eventTemplateService.getTemplateById(templateId, creatorId, tenantId);
    return res.status(200).json({ success: true, data: template });
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return next(AppError.notFound("Filter template not found"));
    }
    return next(error);
  }
};

exports.updateTemplate = async (req, res, next) => {
  try {
    if (!assertCrmUser(req, next)) return;
    const { creatorId, tenantId } = requestContext(req);
    const { templateId } = req.params;

    const existingTemplate = await eventTemplateService.getTemplateById(
      templateId,
      creatorId,
      tenantId,
    );

    const validatedData = validateUpdateEventTemplate(req.body);
    const isPreferenceOnly =
      existingTemplate?.systemDefault && isSystemDefaultPreferenceOnlyUpdate(validatedData);
    if (
      existingTemplate?.systemDefault &&
      !isPreferenceOnly &&
      !canEditSystemDefaultTemplate(req)
    ) {
      return next(
        AppError.forbidden(
          "Access denied. Only System Administrator with Assistant Super User or Super User role can update system default templates.",
        ),
      );
    }

    const template = await eventTemplateService.updateTemplate(
      templateId,
      creatorId,
      validatedData,
      tenantId,
      canEditSystemDefaultTemplate(req),
    );

    return res.status(200).json({
      success: true,
      data: template,
      message: "Filter template updated successfully",
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return next(AppError.notFound("Filter template not found"));
    }
    return next(error);
  }
};

exports.deleteTemplate = async (req, res, next) => {
  try {
    if (!assertCrmUser(req, next)) return;
    const { creatorId, tenantId } = requestContext(req);
    const { templateId } = req.params;

    await eventTemplateService.deleteTemplate(templateId, creatorId, tenantId);

    return res.status(200).json({
      success: true,
      data: null,
      message: "Filter template deleted successfully",
    });
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return next(AppError.notFound("Filter template not found"));
    }
    return next(error);
  }
};

exports.getDefaultTemplate = async (req, res, next) => {
  try {
    if (!assertCrmUser(req, next)) return;
    const { creatorId, tenantId } = requestContext(req);

    const template = await eventTemplateService.getDefaultTemplate(creatorId, tenantId);
    return res.status(200).json({ success: true, data: template });
  } catch (error) {
    return next(error);
  }
};
