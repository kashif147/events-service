const jwt = require("jsonwebtoken");
const { AppError } = require("../errors/AppError");
const { validateGatewayRequest } = require("@membership/policy-middleware/security");

/**
 * AUTHENTICATION MIDDLEWARE ONLY
 * 
 * This middleware handles authentication (verifying user identity).
 * It does NOT handle authorization (permission checks).
 * 
 * For authorization, use policy-middleware:
 * const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
 * router.get("/resource", defaultPolicyMiddleware.requirePermission("resource", "action"), handler);
 * 
 * All authorization decisions are made by user-service /policy/evaluate endpoint.
 */
const authenticate = async (req, res, next) => {
  try {
    console.log("=== AUTH MIDDLEWARE START ===");
    console.log("AUTH_BYPASS_ENABLED:", process.env.AUTH_BYPASS_ENABLED);
    console.log("Request headers:", Object.keys(req.headers));

    // 1) Check for gateway-verified JWT (trust gateway headers with validation)
    const jwtVerified = req.headers["x-jwt-verified"];
    const authSource = req.headers["x-auth-source"];

    if (jwtVerified === "true" && authSource === "gateway") {
      // Validate gateway request (signature, IP, format)
      const validation = validateGatewayRequest(req);
      if (!validation.valid) {
        console.warn("Gateway header validation failed:", validation.reason);
        const authError = AppError.unauthorized("Invalid gateway request", {
          tokenError: true,
          validationError: validation.reason,
        });
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            validationError: authError.validationError,
          },
        });
      }

      // Gateway has verified JWT and forwarded claims as headers
      const userId = req.headers["x-user-id"];
      const tenantId = req.headers["x-tenant-id"];
      const userEmail = req.headers["x-user-email"];
      const userType = req.headers["x-user-type"];
      const userRolesStr = req.headers["x-user-roles"] || "[]";
      const userPermissionsStr = req.headers["x-user-permissions"] || "[]";

      if (!userId || !tenantId) {
        const authError = AppError.badRequest(
          "Missing required authentication headers",
          {
            tokenError: true,
            missingHeaders: true,
          }
        );
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            missingHeaders: authError.missingHeaders,
          },
        });
      }

      let roles = [];
      let permissions = [];

      try {
        const rolesArray = JSON.parse(userRolesStr);
        roles = Array.isArray(rolesArray)
          ? rolesArray
              .map((role) => (typeof role === "string" ? role : role?.code))
              .filter(Boolean)
          : [];
      } catch (e) {
        console.warn("Failed to parse x-user-roles header:", e.message);
      }

      try {
        permissions = JSON.parse(userPermissionsStr);
        if (!Array.isArray(permissions)) permissions = [];
      } catch (e) {
        console.warn("Failed to parse x-user-permissions header:", e.message);
      }

      // Set request context with tenant isolation
      req.ctx = {
        tenantId,
        userId,
        roles,
        permissions,
      };

      // Attach user info to request for backward compatibility
      req.user = {
        sub: userId,
        id: userId,
        tenantId,
        email: userEmail,
        userType,
        roles,
        permissions,
      };

      req.userId = userId;
      req.tenantId = tenantId;
      req.roles = roles;
      req.permissions = permissions;

      console.log("=== AUTH MIDDLEWARE SUCCESS (Gateway) ===");
      console.log("Request context set:", {
        userId: req.userId,
        tenantId: req.tenantId,
        userType: req.user?.userType,
      });
      return next();
    }

    // 2) Check if auth bypass is enabled (legacy support)
    if (process.env.AUTH_BYPASS_ENABLED === "true") {
      console.log(
        "=== AUTH BYPASS ENABLED - Will skip authorization but still validate token ==="
      );

      // Check if this is an authentication endpoint - bypass should NEVER be used for these
      const authEndpoints = [
        "/login",
        "/signin",
        "/signup",
        "/register",
        "/auth",
      ];
      const isAuthEndpoint = authEndpoints.some((endpoint) =>
        req.path.toLowerCase().includes(endpoint.toLowerCase())
      );

      if (isAuthEndpoint) {
        console.error(
          "=== SECURITY ERROR: Bypass attempted on authentication endpoint ==="
        );
        console.error("Path:", req.path);
        const authError = AppError.badRequest(
          "Authentication bypass is not allowed for authentication endpoints",
          {
            tokenError: true,
            securityError: true,
          }
        );
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            securityError: authError.securityError,
          },
        });
      }

      // For non-auth endpoints, still validate token but skip authorization checks
      const authHeader = req.headers.authorization || req.headers.Authorization;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);

          const tenantId =
            decoded.tenantId || decoded.tid || decoded.extension_tenantId;

          if (!tenantId) {
            const authError = AppError.badRequest(
              "Invalid token: missing tenantId",
              {
                tokenError: true,
                missingTenantId: true,
              }
            );
            return res.status(authError.status).json({
              error: {
                message: authError.message,
                code: authError.code,
                status: authError.status,
                tokenError: authError.tokenError,
                missingTenantId: authError.missingTenantId,
              },
            });
          }

          req.ctx = {
            tenantId: tenantId,
            userId: decoded.sub || decoded.id,
            roles: decoded.roles || [],
            permissions: decoded.permissions || [],
          };

          req.user = decoded;
          req.userId = decoded.sub || decoded.id;
          req.tenantId = tenantId;
          req.roles = decoded.roles || [];
          req.permissions = decoded.permissions || [];

          console.log("=== AUTH BYPASS: Using token context ===");
          return next();
        } catch (error) {
          console.error("JWT Verification Error during bypass:", error.message);
          const authError = AppError.badRequest("Invalid token", {
            tokenError: true,
            jwtError: error.message,
          });
          return res.status(authError.status).json({
            error: {
              message: authError.message,
              code: authError.code,
              status: authError.status,
              tokenError: authError.tokenError,
              jwtError: authError.jwtError,
            },
          });
        }
      } else {
        const authError = AppError.badRequest("Authorization header required", {
          tokenError: true,
          missingHeader: true,
        });
        return res.status(authError.status).json({
          error: {
            message: authError.message,
            code: authError.code,
            status: authError.status,
            tokenError: authError.tokenError,
            missingHeader: authError.missingHeader,
          },
        });
      }
    }

    // 3) Legacy Bearer JWT flow (fallback for direct service calls)
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("Missing or invalid authorization header");
      const authError = AppError.badRequest("Authorization header required", {
        tokenError: true,
        missingHeader: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          missingHeader: authError.missingHeader,
        },
      });
    }

    const token = authHeader.substring(7);
    console.log("Token (first 20 chars):", token.substring(0, 20) + "...");

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET environment variable is not set!");
      throw new Error("JWT_SECRET environment variable is required");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("JWT decoded successfully:", {
      sub: decoded.sub,
      id: decoded.id,
      tenantId: decoded.tenantId,
      userType: decoded.userType,
    });

    const tenantId =
      decoded.tenantId || decoded.tid || decoded.extension_tenantId;

    if (!tenantId) {
      const authError = AppError.badRequest("Invalid token: missing tenantId", {
        tokenError: true,
        missingTenantId: true,
      });
      return res.status(authError.status).json({
        error: {
          message: authError.message,
          code: authError.code,
          status: authError.status,
          tokenError: authError.tokenError,
          missingTenantId: authError.missingTenantId,
        },
      });
    }

    if (!decoded.userType) {
      console.warn(
        "WARNING: JWT token missing userType claim. This may cause authorization failures."
      );
    }

    req.ctx = {
      tenantId: tenantId,
      userId: decoded.sub || decoded.id,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };

    req.user = decoded;
    req.userId = decoded.sub || decoded.id;
    req.tenantId = tenantId;
    req.roles = decoded.roles || [];
    req.permissions = decoded.permissions || [];

    console.log("=== AUTH MIDDLEWARE SUCCESS ===");
    console.log("Request context set:", {
      userId: req.userId,
      tenantId: req.tenantId,
      userType: req.user?.userType,
    });
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);
    const authError = AppError.badRequest("Invalid token", {
      tokenError: true,
      jwtError: error.message,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        tokenError: authError.tokenError,
        jwtError: authError.jwtError,
      },
    });
  }
};

// Helper function to check if user has any of the specified roles
function hasAnyRole(userRoles, requiredRoles) {
  if (!userRoles || !Array.isArray(userRoles)) return false;

  // Handle both role objects and role codes
  const userRoleCodes = userRoles.map((role) =>
    typeof role === "string" ? role : role.code
  );

  return requiredRoles.some((role) => userRoleCodes.includes(role));
}

// Helper function to check if user has specific role
function hasRole(userRoles, requiredRole) {
  if (!userRoles || !Array.isArray(userRoles)) return false;

  // Handle both role objects and role codes
  const userRoleCodes = userRoles.map((role) =>
    typeof role === "string" ? role : role.code
  );

  return userRoleCodes.includes(requiredRole);
}

/**
 * AUTHORIZATION FUNCTIONS REMOVED
 * 
 * requireRole and requirePermission have been removed.
 * All authorization must be done via policy-middleware to maintain single source of truth.
 * 
 * Use policy-middleware for authorization:
 * const { defaultPolicyMiddleware } = require("../middlewares/policy.middleware");
 * router.get("/resource", defaultPolicyMiddleware.requirePermission("resource", "action"), handler);
 */

/**
 * Tenant Enforcement Middleware
 * Ensures tenantId is present in req.ctx
 */
const requireTenant = (req, res, next) => {
  if (!req.ctx || !req.ctx.tenantId) {
    const authError = AppError.badRequest("Tenant context required", {
      authError: true,
      missingTenant: true,
    });
    return res.status(authError.status).json({
      error: {
        message: authError.message,
        code: authError.code,
        status: authError.status,
        authError: authError.authError,
        missingTenant: authError.missingTenant,
      },
    });
  }
  next();
};

/**
 * Helper function to add tenantId to MongoDB queries
 */
const withTenant = (tenantId) => {
  return { tenantId };
};

/**
 * Helper function to add tenantId to MongoDB aggregation pipelines
 */
const addTenantMatch = (tenantId) => {
  return { $match: { tenantId } };
};

// Export all middleware functions
module.exports = {
  // Core authentication ONLY - no authorization logic here
  authenticate,
  ensureAuthenticated: authenticate, // Alias for backward compatibility

  // Tenant enforcement (authentication context, not authorization)
  requireTenant,

  // Utility functions (for backward compatibility, but prefer policy-middleware)
  hasRole,
  hasAnyRole,

  // Database helpers
  withTenant,
  addTenantMatch,
};
