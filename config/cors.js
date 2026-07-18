const cors = require("cors");

// CORS for direct (non-gateway) access - e.g. local dev where the CRM/portal
// frontends call this service straight on its own port rather than through
// the gateway's single-origin proxy. Mirrors profile-service/config/cors.js.
const getCorsConfig = () => {
  const environment = process.env.NODE_ENV || "development";

  const baseOrigins = {
    development: [
      "http://localhost:3000",
      "https://localhost:3000", // CRM (react-scripts start --experimental-https)
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "https://127.0.0.1:3000",
      "http://127.0.0.1:5173",
    ],
    staging: ["http://localhost:3000", "https://localhost:3000"],
    production: [],
  };

  const additionalOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [];
  const validAdditionalOrigins = additionalOrigins
    .map((o) => o.trim())
    .filter((origin) => {
      if (!origin) return false;
      try {
        const url = new URL(origin);
        return ["http:", "https:"].includes(url.protocol);
      } catch {
        return false;
      }
    });

  const uniqueOrigins = [
    ...new Set([...(baseOrigins[environment] || baseOrigins.development), ...validAdditionalOrigins]),
  ];

  return {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (uniqueOrigins.includes(origin)) return callback(null, true);
      const vercelPattern = /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/;
      if (vercelPattern.test(origin)) return callback(null, true);
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Request-ID",
      "X-Correlation-ID",
      "X-Tenant-ID",
      "X-Internal-Request",
    ],
    exposedHeaders: ["X-Request-ID", "X-Correlation-ID"],
    maxAge: 86400,
  };
};

const corsMiddleware = cors(getCorsConfig());

const corsErrorHandler = (err, req, res, next) => {
  if (err.message && err.message.includes("Not allowed by CORS")) {
    return res.status(403).json({
      error: { message: "CORS policy violation", code: "CORS_ERROR", status: 403 },
    });
  }
  next(err);
};

module.exports = { corsMiddleware, corsErrorHandler, getCorsConfig };
