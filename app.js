var path = require("path");
if (process.env.NODE_ENV === "staging") {
  require("dotenv").config({ path: ".env.staging" });
} else if (process.env.NODE_ENV !== "production") {
  require("dotenv").config({ path: ".env.development" });
}

var createError = require("http-errors");
var express = require("express");

const { mongooseConnection } = require("./config/db");
const session = require("express-session");

const loggerMiddleware = require("./middlewares/logger.mw");
const responseMiddleware = require("./middlewares/response.mw");
const { authenticate } = require("./middlewares/auth");
const { corsMiddleware, corsErrorHandler } = require("./config/cors");

var app = express();

app.set("etag", false);

// Disabled now that the gateway has a working /events-service/api/ route with
// its own CORS headers (matching every sibling service) - having both add
// CORS headers produces duplicate/conflicting values (e.g. two different
// Access-Control-Expose-Headers), which browsers reject even though curl
// doesn't. Re-enable only for direct-to-service local testing that bypasses
// the gateway entirely.
// app.use(corsMiddleware);

const bizLogger = require("./config/bizLogger.js");
const {
  correlationIdMiddleware,
  logErrorMiddleware,
  createSystemLogsRouter,
} = require("@projectShell/logging-lib");

app.use(correlationIdMiddleware);
app.use(responseMiddleware);

mongooseConnection()
  .then(() => console.log("✅ MongoDB connected successfully"))
  .catch((err) => console.error("❌ MongoDB connection failed:", err.message));

const {
  initEventSystem,
  setupConsumers,
  shutdownEventSystem,
} = require("./rabbitMQ");

if (process.env.RABBIT_URL) {
  console.log("🐰 RabbitMQ URL configured, initializing with middleware...");
  initEventSystem()
    .then(() => {
      console.log("✅ Initializing RabbitMQ consumers...");
      return setupConsumers();
    })
    .then(() => {
      const { startEventCompletionSweep } = require("./jobs/eventCompletionSweep.js");
      const { startOnlineAttendanceSyncSweep } = require("./jobs/onlineAttendanceSyncSweep.js");
      startEventCompletionSweep();
      startOnlineAttendanceSyncSweep();
      console.log("✅ RabbitMQ fully initialized with middleware");
    })
    .catch((error) => {
      console.error("❌ Failed to initialize RabbitMQ:", error.message);
      console.error("⚠️ App will continue without RabbitMQ (degraded mode)");
    });

  process.on("SIGTERM", async () => {
    console.log("⏹️  SIGTERM received, shutting down gracefully...");
    const { stopEventCompletionSweep } = require("./jobs/eventCompletionSweep.js");
    const { stopOnlineAttendanceSyncSweep } = require("./jobs/onlineAttendanceSyncSweep.js");
    stopEventCompletionSweep();
    stopOnlineAttendanceSyncSweep();
    await shutdownEventSystem();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("⏹️  SIGINT received, shutting down gracefully...");
    const { stopEventCompletionSweep } = require("./jobs/eventCompletionSweep.js");
    const { stopOnlineAttendanceSyncSweep } = require("./jobs/onlineAttendanceSyncSweep.js");
    stopEventCompletionSweep();
    stopOnlineAttendanceSyncSweep();
    await shutdownEventSystem();
    process.exit(0);
  });
} else {
  console.warn("⚠️ RABBIT_URL not configured, skipping RabbitMQ initialization");
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "50mb" }));

app.use("/api", createSystemLogsRouter(bizLogger));

app.use(loggerMiddleware);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "events-service-secret",
    resave: false,
    saveUninitialized: false,
  }),
);

app.use((err, req, res, next) => {
  if (err.isPolicyError) {
    console.error("Policy service error:", err.message);
    return res.status(503).json({ error: "Service Unavailable" });
  }
  next(err);
});

// Health check endpoint (no auth required)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP" });
});

// Public (unauthenticated) - the check-in token itself is the credential,
// same reasoning /health and GET /api already get.
app.use("/api/public", require("./routes/publicCheckin.routes.js"));

app.get("/api", (req, res) => {
  res.json({
    service: "Events & Courses Service API",
    version: "1.0.0",
    endpoints: {
      health: "GET /health",
      events: "GET/POST /api/events (auth required)",
      courses: "GET/POST /api/courses (auth required)",
      registrations: "GET/POST /api/registrations (auth required)",
      certificates: "POST /api/certificates/:registrationId/issue (auth required)",
    },
  });
});

app.use(authenticate);
app.use("/api", require("./routes/index"));

app.use(function (req, res, next) {
  res.status(404).json({
    error: "NOT_FOUND",
    message: "Not found",
    path: req.originalUrl,
  });
});

// app.use(corsErrorHandler); // disabled alongside corsMiddleware above
app.use(logErrorMiddleware(bizLogger));
app.use(responseMiddleware.errorHandler);

process.on("SIGINT", async () => {
  process.exit(0);
});

module.exports = app;
