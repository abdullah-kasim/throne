import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { specFileText } from "../../scripts/spec-behaviour-evidence-fixture.mjs";
import { runQuietly } from "./spec-fixture.test-support.ts";

let scratch: string;
before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "feature-map-"));
});
after(() => rm(scratch, { recursive: true, force: true }));

const alpha = (overrides = {}) => specFileText({ name: "Alpha", summary: "Does alpha work.", code: ["src/alpha.ts"], subFeatures: ["AL1"], searchWords: "alpha-command", ...overrides });
const beta = (overrides = {}) => specFileText({ name: "Beta", summary: "Does beta work.", code: ["src/beta.ts"], subFeatures: ["BE1"], ...overrides });

async function specSet(caseName: string, files: Record<string, string>): Promise<string> {
  const root = path.join(scratch, caseName);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "alpha.ts"), "");
  await writeFile(path.join(root, "src", "beta.ts"), "");
  for (const [relativePath, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, "specs", relativePath)), { recursive: true });
    await writeFile(path.join(root, "specs", relativePath), text);
  }
  return path.join(root, "specs");
}

test("the map has one line per feature, names its covered areas and is byte-identical when built twice", async () => {
  const folder = await specSet("valid", { "first/alpha.md": alpha(), "second/beta.md": beta() });
  assert.equal((await runQuietly([folder])).exitCode, 0);
  const firstMap = await readFile(path.join(folder, "FEATURE_MAP.md"), "utf8");
  assert.match(firstMap, /- \*\*Alpha\*\*: Does alpha work\. \(\[first\/alpha\.md\]\(first\/alpha\.md\)\)/);
  assert.match(firstMap, /Covered areas: first, second\.\nEverything else is uncatalogued/);
  await runQuietly([folder]);
  assert.equal(await readFile(path.join(folder, "FEATURE_MAP.md"), "utf8"), firstMap);
});

test("a map edited by hand fails the check until it is regenerated", async () => {
  const folder = await specSet("hand-edited", { "first/alpha.md": alpha() });
  await runQuietly([folder]);
  await writeFile(path.join(folder, "FEATURE_MAP.md"), "edited\n");
  const stale = await runQuietly([folder, "--check"]);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.stderr, /out of date/);
  await runQuietly([folder]);
  assert.equal((await runQuietly([folder, "--check"])).exitCode, 0);
});

const fatalCases: [string, Record<string, string>, RegExp][] = [
  ["two spec files with the same feature name", { "a/alpha.md": alpha(), "b/other.md": beta({ name: "Alpha" }) }, /"Alpha" is claimed by a\/alpha\.md and b\/other\.md/],
  ["two spec files declaring the same sub-feature ID", { "a/alpha.md": alpha(), "b/beta.md": beta({ subFeatures: ["AL1"] }) }, /AL1 is declared by a\/alpha\.md and b\/beta\.md/],
  ["a header naming a path that does not exist", { "a/alpha.md": alpha({ code: ["src/gone.ts"] }) }, /a\/alpha\.md names the path src\/gone\.ts/],
  ["a spec file over the size limit", { "a/alpha.md": alpha({ extraLines: 300 }) }, /a\/alpha\.md is 320 lines, over the limit of 300/],
  ["a spec file missing a fixed section", { "a/alpha.md": alpha({ skipSection: "## Gotchas" }) }, /a\/alpha\.md is missing the section "## Gotchas"/],
];

for (const [index, [title, files, message]] of fatalCases.entries()) {
  test(`${title} exits non-zero, names the files and writes no map`, async () => {
    const folder = await specSet(`fatal-${index}`, files);
    const result = await runQuietly([folder]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, message);
    await assert.rejects(readFile(path.join(folder, "FEATURE_MAP.md")));
  });
}

test("two spec files claiming the same code path are reported without failing", async () => {
  const folder = await specSet("overlap", { "a/alpha.md": alpha(), "b/beta.md": beta({ code: ["src"] }) });
  const result = await runQuietly([folder]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /reported: a\/alpha\.md and b\/beta\.md both claim the code path src\/alpha\.ts \/ src/);
});

test("a registry entry no spec claims in its search words is reported as a gap naming the entry", async () => {
  const folder = await specSet("registry", { "a/alpha.md": alpha() });
  const result = await runQuietly([folder, "--registry", "throne"], ["alpha-command", "beta-command"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /reported: the registry entry beta-command is claimed by no spec file/);
  assert.doesNotMatch(result.stderr, /alpha-command/);
});

test("the compiled command reads the throne registry and reports its unclaimed commands", async () => {
  const folder = await specSet("compiled-registry", { "a/alpha.md": alpha() });
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist", "src", "tools.js"), "feature-map", folder, "--registry", "throne"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reported: the registry entry feature-map is claimed by no spec file/);
});
