import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { lintQueuePlanBody, QUEUE_PLAN_MARKERS } from "../src/lint-queue-plan/lint-queue-plan.ts";
import { missingPhrases, readMarkdownSection } from "./skill-contract-test-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TICKET_BLOCK_HEADING = "#### When the objective has a ticket, add a `TICKET:` block";

function unwrap(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

async function readWriteTheBodyStep(): Promise<string> {
  const skill = await readFile(path.join(ROOT, ".claude/skills/queue-objective/SKILL.md"), "utf8");
  const step = readMarkdownSection(skill, "### 2. Write the body — five markers, for the weakest configured reader");
  assert.notEqual(step, "", "queue-objective has no write-the-body step");
  return step;
}

async function readTicketBlockRule(): Promise<string> {
  const rule = readMarkdownSection(await readWriteTheBodyStep(), TICKET_BLOCK_HEADING);
  assert.notEqual(rule, "", "the write-the-body step has no TICKET block rule");
  return rule;
}

test("a ticket-driven queue row quotes the ticket verbatim, read fresh, in a TICKET block", async () => {
  const rule = unwrap(await readTicketBlockRule());
  assert.deepEqual(
    missingPhrases(rule, [
      "**Read the ticket fresh, now.** Use the Linear MCP (`get_issue`, then `list_comments`), or `ghe issue view <number> --comments`",
      "Never quote from a summary",
      "**Quote it verbatim under `TICKET:`:** the ticket's link, its description, every acceptance point, and every comment that changes the ask.",
      "**Number the quoted points T1, T2, …**",
      "`/ticket-check`",
    ]),
    [],
  );
});

test("every quoted ticket point maps to SCOPE or to a ruling, and an unmapped point goes to the Lord before filing", async () => {
  const rule = await readTicketBlockRule();
  assert.deepEqual(
    missingPhrases(unwrap(rule), [
      "**Map every point** with `→` either to where `SCOPE:` covers it, or to the `RULINGS:` line that knowingly changes or drops it.",
      "**A point with neither is a gap.** Raise it with the Lord before filing",
      "Never file with an unmapped point",
    ]),
    [],
  );
  const quotedPoints = rule.split("\n").filter((line) => /^- T\d+ /.test(line));
  assert.ok(quotedPoints.length >= 2, "the shape example quotes at least two numbered points");
  quotedPoints.forEach((point, index) => {
    assert.match(point, new RegExp(`^- T${index + 1} \\(.+\\): ".+" → (SCOPE|RULINGS): .+`));
  });
});

test("a queue body with a TICKET block alongside the five markers passes the plan lint", async () => {
  assert.equal(QUEUE_PLAN_MARKERS.length, 5);
  assert.ok(!QUEUE_PLAN_MARKERS.some(({ marker }) => marker === "TICKET:"));
  assert.ok(unwrap(await readTicketBlockRule()).includes("The lint stays five-marker: `TICKET:` is an extra block it accepts"));
  const body = [
    "INTENT: show the discount on every invoice line.",
    "SCOPE: invoice line rendering; not the invoice email.",
    'RULINGS: the invoice email is dropped ("not this round" — owner, 2026-10-06).',
    "VERIFIED-NOUNS: formatMoney.",
    "REUSE: web/money.ts:12 formatMoney already formats prices.",
    "TICKET: https://tracker.example/SHOP-12",
    '- T1 (description): "Show the discount on every invoice line." → SCOPE: invoice line rendering.',
    '- T2 (comment): "Also email the invoice to the customer." → RULINGS: dropped.',
  ].join("\n");
  assert.deepEqual(lintQueuePlanBody(body), []);
});
