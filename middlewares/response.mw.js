module.exports = (req, res, next) => {
  res.success = (data) => {
    res.status(200).json({ status: "success", data });
  };

  res.serverError = (error) => {
    if (error.isJoi) {
      let data = error.details.map((d) => d.message);
      data = data.join(", ");
      console.log(`ERROR: [${req.method}-${req.url}] ${data}`);
      res.status(400).json({
        success: false,
        error: {
          message: data,
          code: "BAD_REQUEST",
          status: 400,
        },
      });
    } else {
      console.log(`ERROR: [${req.method}-${req.url}] ${error}`);
      res.status(500).json({
        success: false,
        error: {
          message: "Internal Server Error",
          code: "INTERNAL_SERVER_ERROR",
          status: 500,
        },
      });
    }
  };

  res.fail = (data) => {
    res.status(400).json({
      success: false,
      error: {
        message: data,
        code: "BAD_REQUEST",
        status: 400,
      },
    });
  };

  res.sendResponse = (statusCode, data) => {
    res.status(statusCode).json({ status: statusCode, data });
  };

  // Standardized not found responses (200 OK instead of 404)
  res.notFoundList = (message = "No records found") => {
    res.status(200).json({
      success: true,
      data: [],
      message,
    });
  };

  res.notFoundRecord = (message = "Record not found") => {
    res.status(200).json({
      success: true,
      data: null,
      message,
    });
  };

  next();
};

// Error handling middleware for AppError
module.exports.errorHandler = (error, req, res, next) => {
  const correlationId =
    req.correlationId ||
    req.headers["x-correlation-id"] ||
    req.id ||
    "unknown";

  if (error.name === "AppError") {
    return res.status(error.status).json({
      success: false,
      error: {
        message: error.message,
        code: error.code,
        status: error.status,
        ...error,
      },
      correlationId,
    });
  }

  // Handle Joi validation errors
  if (error.isJoi) {
    const data = error.details.map((d) => d.message).join(", ");
    return res.status(400).json({
      success: false,
      error: {
        message: "Validation error: " + data,
        code: "BAD_REQUEST",
        status: 400,
      },
      correlationId,
    });
  }

  if (error.name === "CastError" || error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      error: {
        message: error.message,
        code: "BAD_REQUEST",
        status: 400,
      },
      correlationId,
    });
  }

  if (error.status >= 400 && error.status < 500 && error.message) {
    return res.status(error.status).json({
      success: false,
      error: {
        message: error.message,
        code: error.code || "BAD_REQUEST",
        status: error.status,
      },
      correlationId,
    });
  }

  // Default server error
  console.log(`ERROR: [${req.method}-${req.url}] ${error}`);
  res.status(500).json({
    success: false,
    error: {
      message:
        process.env.NODE_ENV === "production"
          ? "Internal Server Error"
          : error.message || "Internal Server Error",
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    },
    correlationId,
  });
};
