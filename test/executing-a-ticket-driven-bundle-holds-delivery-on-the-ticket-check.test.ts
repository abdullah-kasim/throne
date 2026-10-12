import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { missingPhrases, readMarkdownSection } from "./skill-contract-test-helpers.ts";

const EXECUTE_TODOS_SKILL = resolve(import.meta.dirname, "..", ".claude/skills/execute-todos/SKILL.md");

async function readUnwrappedSection(heading: string): Promise<string> {
  const section = readMarkdownSection(await readFile(EXECUTE_TODOS_SKILL, "utf8"), heading);
  assert.notEqual(section, "", `no section is headed "${heading}"`);
  return section.replace(/\s*\n\s*/g, " ");
}

test("the ticket-alignment Shadow is spawned verdict-only", async () => {
  const oneWorkerPerTodo = await readUnwrappedSection("### 2. One worker per todo — a fresh real Shadow every time, never continue");
  assert.deepEqual(
    missingPhrases(oneWorkerPerTodo, [
      "A ticket-driven bundle's `98_ticket_<topic>` Shadow also carries `--deliverable-shape verdict-only`.",
      "It is an ordinary-band slice from `rolePools.Shadow` that runs after every other ordinary slice has landed",
      "so its branch is empty by design.",
    ]),
    [],
  );
});

test("conformance waits for a PASS ticket-alignment outcome and fails without one", async () => {
  const oneWorkerPerTodo = await readUnwrappedSection("### 2. One worker per todo — a fresh real Shadow every time, never continue");
  assert.ok(
    oneWorkerPerTodo.includes(
      "When the bundle has a `98_ticket_` todo, `99a_conform` does not start until that todo records `**Ticket alignment outcome:** PASS`",
    ),
  );
  const waitsForTheTicketCheck = await readUnwrappedSection("#### `99a` waits for the ticket-alignment check");
  assert.deepEqual(
    missingPhrases(waitsForTheTicketCheck, [
      "carries a `98_ticket_<topic>.md` todo that depends on every ordinary slice",
      "runs `/ticket-check` on the candidate, passing the queue row's `RULINGS:` and every recorded amendment as its rulings",
      "exactly one `**Ticket alignment outcome:** PASS` or `**Ticket alignment outcome:** FAIL`",
      "writes `ticket-warning.md` into the bundle folder",
      "or the single line `no warning needed`",
      "This skill calls `/ticket-check` and never restates its procedure.",
      "`99a` does not start until that todo records `**Ticket alignment outcome:** PASS`, and `99a` FAILs if the line is not PASS.",
      "so it enforces the ticket check with no change of its own.",
    ]),
    [],
  );
  const conformance = await readUnwrappedSection("#### `99a` — grade the candidate against what was literally asked for");
  assert.ok(
    conformance.includes(
      "When the bundle has a `98_ticket_` todo, `99a` reads that todo's file and returns FAIL unless it carries `**Ticket alignment outcome:** PASS` on its own line.",
    ),
  );
});

test("a failed ticket check is corrective work for the campaign owner, then a fresh check", async () => {
  const waitsForTheTicketCheck = await readUnwrappedSection("#### `99a` waits for the ticket-alignment check");
  assert.ok(
    waitsForTheTicketCheck.includes(
      "A FAIL (a ticket line UNMET with no ruling behind it) is corrective work for the owning Alpha, exactly like a `99a` FAIL: one consolidated corrective slice, then a fresh `98_ticket_` Shadow re-runs the check.",
    ),
  );
});

test("pull-request delivery publishes the ticket warning in a Ticket Status section after Agents", async () => {
  const pullRequestDelivery = await readUnwrappedSection("#### Pull-request delivery — when the deliverable is a PR, not a merge");
  assert.deepEqual(
    missingPhrases(pullRequestDelivery, [
      "When the bundle's `ticket-warning.md` holds a warning block, `99c` publishes it verbatim at the very bottom, after `## Agents`, as the Ticket Status section `/pr-description` describes.",
      "When it holds `no warning needed`, the body has no `## Ticket Status` section at all.",
      "`## Agents` is the last section unless a `## Ticket Status` section closes the body.",
    ]),
    [],
  );
  assert.equal(pullRequestDelivery.includes("top of the PR body"), false);
});

test("a sliceless campaign on a ticket cannot record a conformance PASS without a PASS ticket check", async () => {
  const slicelessMode = await readUnwrappedSection("## Sliceless mode — Lord-authorized only");
  assert.deepEqual(
    missingPhrases(slicelessMode, [
      "When the queue row carries a `TICKET:` block, this part also records a `/ticket-check` run on the candidate, with the row's `RULINGS:` and every amendment as its rulings",
      "`**Ticket alignment outcome:** PASS` or `**Ticket alignment outcome:** FAIL`.",
      "`**Conformance outcome:** PASS` is not allowed unless that line reads PASS.",
      "goes into the PR body the way \"Pull-request delivery\" says.",
    ]),
    [],
  );
  const conformanceCheckAt = slicelessMode.indexOf("1. **Conformance check**");
  const ticketCheckAt = slicelessMode.indexOf("When the queue row carries a `TICKET:` block");
  const verificationRecordAt = slicelessMode.indexOf("2. **Verification record**");
  assert.ok(conformanceCheckAt < ticketCheckAt && ticketCheckAt < verificationRecordAt, "the ticket check sits inside the conformance part of verify.md");
});
