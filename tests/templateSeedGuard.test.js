// Source guard: grid "Save View" system defaults are tenant-owned and are only ever inserted by
// explicit-tenant, insert-only tooling. The retired seed paths created shared tenantless defaults,
// overwrote existing defaults with --force (writing straight through Mongoose, so outside the A14
// freeze), or deleted every tenant's templates. They must not come back.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const scriptFiles = walk(path.join(ROOT, "scripts")).filter((f) => /\.(c|m)?js$/.test(f));
const read = (f) => fs.readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f);

const RETIRED = ["scripts/seed-grid-system-default-template.js"];

test("retired template seed scripts stay retired", () => {
  for (const f of RETIRED) expect(fs.existsSync(path.join(ROOT, f))).toBe(false);
});

test("no script uses the tenantless root grid-default seed library or wrapper", () => {
  const offenders = scriptFiles.filter((f) => /seed-grid-system-default-lib|seed-grid-system-defaults\.c?js/.test(read(f)));
  expect(offenders.map(rel)).toEqual([]);
});

test("no script deletes every template (unfiltered deleteMany on templates)", () => {
  const offenders = scriptFiles.filter((f) =>
    /Template\.deleteMany\(\s*\{\s*\}\s*\)|collection\(\s*["']templates["']\s*\)\.deleteMany\(\s*\{\s*\}\s*\)/.test(read(f)),
  );
  expect(offenders.map(rel)).toEqual([]);
});

test("package.json has no template seed script (root wrapper, --force seeding)", () => {
  const scripts = JSON.parse(read(path.join(ROOT, "package.json"))).scripts || {};
  const offenders = Object.entries(scripts).filter(
    ([name, cmd]) => /seed-grid-system-default/.test(cmd) || (/seed/i.test(name) && /--force/.test(cmd)),
  );
  expect(offenders).toEqual([]);
});
