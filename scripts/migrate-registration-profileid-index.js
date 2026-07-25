/**
 * One-off migration for the profileId-scoped unique registration index (see
 * registration.model.js). Run once per environment after deploying the
 * defer-profile-resolution-to-approval change: drops and recreates the two
 * {tenantId, eventId|courseId, profileId} unique indexes with
 * profileId:{$type:"string"} added to the partialFilterExpression (Mongoose
 * does not auto-migrate a changed partialFilterExpression on an existing
 * index). Without this, every pending-review registration (profileId:null)
 * for the same event/course would collide on the old index and 409.
 *
 * Usage:
 *   node scripts/migrate-registration-profileid-index.js --env=staging
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Registration = require("../models/registration.model.js");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (prefix) => {
    const hit = args.find((a) => a.startsWith(`${prefix}=`));
    return hit ? hit.slice(prefix.length + 1).trim() : "";
  };
  return { envName: get("--env") || "staging" };
}

function loadEnv(envName) {
  const envFile = path.join(__dirname, "..", `.env.${envName}`);
  if (!fs.existsSync(envFile)) {
    console.error(`Env file not found: ${envFile}`);
    process.exit(1);
  }
  require("dotenv").config({ path: envFile, override: true });
  console.log(`Loaded env: ${envFile}`);
}

async function main() {
  const { envName } = parseArgs();
  loadEnv(envName);

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL || "";
  if (!mongoUri) {
    console.error("Set MONGO_URI (or MONGODB_URI) in the env file");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const collection = Registration.collection;
  const existing = await collection.indexes();
  for (const spec of existing) {
    const keys = Object.keys(spec.key || {});
    const isEventIdx = keys.join(",") === "tenantId,eventId,profileId";
    const isCourseIdx = keys.join(",") === "tenantId,courseId,profileId";
    if (isEventIdx || isCourseIdx) {
      console.log(`Dropping index ${spec.name}`);
      await collection.dropIndex(spec.name);
    }
  }

  // Recreate from the current schema definition (already updated to include
  // profileId:{$type:"string"} in partialFilterExpression).
  await Registration.syncIndexes();
  console.log("Recreated indexes from current schema");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
