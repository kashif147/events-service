// Tenant-owned grid system defaults: insert-only migration + ensureTenantDefaults, against a REAL
// throwaway mongod (skipped when no mongod binary: set MONGOD_BIN). Suite: tests/helpers/tenantGridDefaultsSuite.js
const g = require("../services/tenantGridDefaults");
const cli = require("../scripts/migrate-grid-defaults-to-tenants");
const { registerTenantGridDefaultsSuite, mongodBin } = require("./helpers/tenantGridDefaultsSuite");

jest.setTimeout(60000);
const run = mongodBin() ? describe : describe.skip;
run("tenant-owned grid system defaults (real mongod)", () => {
  registerTenantGridDefaultsSuite({ test, beforeAll, afterAll, beforeEach }, { g, cli, types: ["attendees"] });
});
