import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { missingPhrases, readMarkdownSection, unwrap } from "./skill-contract-test-helpers.ts";

const SKILLS_DIRECTORY = resolve(import.meta.dirname, "..", ".claude/skills");

async function skillSection(skillName: string, heading: string): Promise<string> {
  const source = await readFile(resolve(SKILLS_DIRECTORY, skillName, "SKILL.md"), "utf8");
  const section = readMarkdownSection(source, heading);
  assert.notEqual(section, "", `${skillName} has a section headed ${heading}`);
  return unwrap(section);
}

const verifyGateSection = () => skillSection("execute-todos", "#### `99b` — run the tests and lint, and fix what fails");
const verifyTemplate = () => skillSection("write-todos", "## The verify todo (`99b_verify_<topic>.md`)");
const verificationLayers = () =>
  skillSection("execute-todos", "#### Three verification layers, and the layers are not interchangeable");
const deliveryGateSection = () =>
  skillSection("execute-todos", "#### `99c` — merge the latest target, resolve conflicts, deliver");
const slicelessSection = () => skillSection("execute-todos", "## Sliceless mode — Lord-authorized only");

const TIER_OPENINGS_IN_ORDER = [
  "**Tier A — the tests nearest the change.**",
  "**Tier B — the tests coverage says reach the change.**",
  "**Tier C — the full suite without slow tests.**",
  "**Tier D — slow tests and container tests,",
];

function tierPositions(text: string): number[] {
  return TIER_OPENINGS_IN_ORDER.map((opening) => text.indexOf(opening));
}

function assertTiersAppearInOrder(text: string, label: string): void {
  const positions = tierPositions(text);
  assert.deepEqual(
    positions.filter((position) => position === -1),
    [],
    `${label} names every tier: ${JSON.stringify(positions)}`,
  );
  assert.deepEqual(positions, [...positions].sort((first, second) => first - second), `${label} keeps tiers A, B, C, D in order`);
}

test("the verify gate checks the changed tests, then the coverage-selected tests, then the suite without slow tests, then decides on slow and container tests", async () => {
  const gate = await verifyGateSection();
  const template = await verifyTemplate();
  assertTiersAppearInOrder(gate, "execute-todos 99b");
  assertTiersAppearInOrder(template, "write-todos verify template");
  for (const text of [gate, template]) {
    assert.deepEqual(
      missingPhrases(text, [
        "the test files the campaign added or changed",
        "a same-name spec or test beside the file, or a test folder mirror",
        "the test files a grep finds importing the touched files",
        "`node --test <files>`",
        "`jest --findRelatedTests <files>`",
        "`vitest related <files>`",
        "`go test ./pkg/...`",
        "`pytest <files>`",
        "`node --test --experimental-test-coverage`",
        "`go test -coverprofile`",
        "coverage.py",
        "say so and skip to Tier C. Never fake the mapping.",
        "with no slow or fast split",
      ]),
      [],
    );
  }
  assert.ok(gate.includes("When the project compares against a base suite, it compares at Tier C."));
});

test("each tier is green before the next one starts", async () => {
  const gate = await verifyGateSection();
  const template = await verifyTemplate();
  const quote = '"1 small test and 1 big test beats 2 big tests."';
  assert.deepEqual(
    missingPhrases(gate, [
      "until it is green; only then does the next tier start.",
      "A bigger tier never starts beside a smaller one",
      quote,
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(template, [
      "re-run it until it is green; only then start the next tier.",
      "Do not start a bigger tier beside a smaller one.",
      quote,
    ]),
    [],
  );
  assert.equal(template.includes("**Then one full suite.**"), false);
});

test("the verify gate decides on the slow tier and on container tests separately, and records one line for each", async () => {
  for (const text of [await verifyGateSection(), await verifyTemplate()]) {
    assert.deepEqual(
      missingPhrases(text, [
        "the slow tier",
        "container tests",
        "off by default",
        "podman or docker",
        "is presumed slow",
        "one line per decision, either way,",
        "`container tests: not run; the change is skill text only`",
        "treat",
        "as part of its slow or default tier",
      ]),
      [],
    );
  }
});

test("no agent ever chooses to run the heavy tier", async () => {
  const gate = await verifyGateSection();
  const template = await verifyTemplate();
  assert.ok(
    gate.includes(
      "The heavy tier (`THRONE_HEAVY_TESTS`) is never part of this decision: it runs only on the Lord's direct order, and no agent ever chooses it.",
    ),
  );
  assert.ok(
    template.includes(
      "The heavy tier is never part of this decision: it runs only on the Lord's direct order, and you never choose it.",
    ),
  );
});

test("only the verify gate decides on slow and container tests; slices and the conformance gate never run them and delivery carries the decision", async () => {
  const gate = await verifyGateSection();
  assert.deepEqual(
    missingPhrases(gate, [
      "The slow-test and container-test decisions are made in `99b`, and in a sliceless campaign's verify step, and nowhere else.",
      "Ordinary slices and `99a` never run slow or container tests;",
      "`99c` carries `99b`'s decisions and results forward and does not decide again.",
    ]),
    [],
  );
  assert.ok((await verificationLayers()).includes("A slice never runs slow or container tests."));
  assert.ok(
    (await deliveryGateSection()).includes(
      "carry `99b`'s slow-test and container-test decisions and their results forward under the carry rules of \"Three verification layers\"; `99c` does not decide them again.",
    ),
  );
});

test("the verify record names each tier's command, selected files, exit code and duration", async () => {
  assert.ok(
    (await verifyGateSection()).includes(
      "The `99b` file records, for each tier, the command, the files it selected, the exit code and the duration, and the two Tier D decision lines.",
    ),
  );
  const template = await verifyTemplate();
  assert.ok(template.includes("Record, for each tier, the command, the files it selected, the exit code and the duration."));
  const deliverable = template.slice(template.indexOf("## Deliverable"));
  assert.ok(deliverable.includes("each tier's command, selected files, exit code and duration; the two Tier D decision lines;"));
});

test("the single assembled suite run is the Tier C run and keeps its carry rules", async () => {
  const layers = await verificationLayers();
  assert.deepEqual(
    missingPhrases(layers, [
      "exactly one baseline-comparative full-suite run over the assembled candidate",
      "This run is the Tier C run of `99b`'s rising tiers: the default suite without slow tests.",
      "The recorded evidence tree must equal the current candidate tree exactly; a mismatch **REFUSES** carry",
      "Tree mismatch is never softened into a warning",
    ]),
    [],
  );
  assert.ok((await verifyGateSection()).includes("This is the single assembled full-suite run of \"Three verification layers\"."));
});

test("a sliceless verification record follows the same tiers and still runs tests, lint and build before the first push", async () => {
  const sliceless = await slicelessSection();
  const record = sliceless.slice(sliceless.indexOf("**Verification record**"), sliceless.indexOf("**Delivery note**"));
  assert.deepEqual(
    missingPhrases(record, [
      "the repository's tests, lint and build",
      "ending in exactly one line `**Verify outcome:** PASS`",
      "The tests run in the same rising tiers A, B, C, D as `99b`, each green before the next,",
      "the slow-test and container-test decisions made here and recorded one line each.",
      "The tiers change how it checks, never whether it checks: the tests, lint and build still run before the first push.",
    ]),
    [],
  );
});
