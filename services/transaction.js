// Runs fn(session) in a MongoDB transaction (replica set required - Atlas on DEV/UAT/PROD; tests use
// a single-node replica set). withTransaction retries transient transaction errors; any other
// thrown error aborts everything written with `session`.
const mongoose = require("mongoose");

async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { withTransaction };
