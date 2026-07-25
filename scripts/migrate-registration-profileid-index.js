/**
 * One-off migration for registration.model.js's unique indexes. Run once per
 * environment after deploying the defer-profile-resolution-to-approval
 * change. Does two things:
 *
 * 1. Drops and recreates the two {tenantId, eventId|courseId, profileId}
 *    unique indexes with profileId:{$type:"string"} added to the
 *    partialFilterExpression (Mongoose does not auto-migrate a changed
 *    partialFilterExpression on an existing index). Without this, every
 *    pending-review registration (profileId:null) for the same event/course
 *    would collide on the old index and 409.
 *
 * 2. Backfills attendeeSnapshot.normalizedEmail on existing documents, then
 *    lets Registration.syncIndexes() create the two new
 *    {tenantId, eventId|courseId, attendeeSnapshot.normalizedEmail} unique
 *    indexes declared in the schema. These restore the duplicate-submission
 *    guard that (1) above incidentally removed: since profileId is always
 *    null at intake now, nothing else in the DB stops two registrations for
 *    the same event/course + same attendee email being created seconds
 *    apart (double-click, network retry, etc.), each with its own Stripe
 *    PaymentIntent.
 *
 * IMPORTANT: if any ACTIVE duplicate registrations already exist for the
 * same {tenantId, eventId|courseId, attendeeSnapshot.normalizedEmail} at
 * the time this runs (e.g. from the exact bug being fixed here), index
 * creation in step 2 will fail with an E11000 error - resolve those first
 * (approve the one with a real captured/posted payment, reject the other)
 * before running this script.
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

  // Backfill attendeeSnapshot.normalizedEmail on existing documents so
  // pre-existing registrations are covered by the new duplicate-submission
  // guard too, not just ones created after this deploy.
  const backfillResult = await collection.updateMany(
    {
      "attendeeSnapshot.email": { $type: "string" },
      $or: [
        { "attendeeSnapshot.normalizedEmail": { $exists: false } },
        { "attendeeSnapshot.normalizedEmail": null },
      ],
    },
    [
      {
        $set: {
          "attendeeSnapshot.normalizedEmail": {
            $toLower: { $trim: { input: "$attendeeSnapshot.email" } },
          },
        },
      },
    ],
  );
  console.log(`Backfilled normalizedEmail on ${backfillResult.modifiedCount} document(s)`);

  // Recreate from the current schema definition (profileId:{$type:"string"}
  // in the partialFilterExpression, plus the two new normalizedEmail
  // indexes) - will throw E11000 if active duplicate registrations still
  // exist for the same event/course + attendee email; see the file header.
  await Registration.syncIndexes();
  console.log("Recreated indexes from current schema");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
