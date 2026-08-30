require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const {tmpdir}: typeof import("node:os") = require("node:os");
const {join}: typeof import("node:path") = require("node:path");
const {spawnSync}: typeof import("node:child_process") = require("node:child_process");
const test: typeof import("node:test").test = require("node:test");

const stageScript = join(
  __dirname,
  "..",
  "lib",
  "scripts",
  "stage-emulator-secrets.js",
);
const fixture = readFileSync(
  join(__dirname, "..", ".secret.emulator"),
  "utf8",
);

test("emulator secret staging creates only the dummy and refuses overwrite", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "book-tracker-secrets-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  writeFileSync(join(directory, ".secret.emulator"), fixture);

  const staged = spawnSync(process.execPath, [stageScript], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(readFileSync(join(directory, ".secret.local"), "utf8"), fixture);

  const existing = "FUNCTIONS_CONFIG_EXPORT=real-local-value\n";
  writeFileSync(join(directory, ".secret.local"), existing);
  const refused = spawnSync(process.execPath, [stageScript], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /differs from the safe emulator fixture/);
  assert.equal(readFileSync(join(directory, ".secret.local"), "utf8"), existing);
});
