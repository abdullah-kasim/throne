import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { missingPhrases, readMarkdownSection } from "./skill-contract-test-helpers.ts";

const WRITE_TODOS_SKILL = resolve(import.meta.dirname, "..", ".claude/skills/write-todos/SKILL.md");

async function writeTodosSection(heading: string): Promise<string> {
  const source = await readFile(WRITE_TODOS_SKILL, "utf8");
  const section = readMarkdownSection(source, heading);
  assert.notEqual(section, "", `write-todos has a section headed ${heading}`);
  return section.replace(/\s+/g, " ");
}

const ticketAlignmentHeading = "## The ticket-alignment todo (`98_ticket_<topic>.md`)";
const conformanceHeading = "## The conformance todo (`99a_conform_<topic>.md`)";
const deliveryHeading = "## The delivery todo (`99c_deliver_<topic>.md`)";

test("a ticket-driven bundle gets a verdict-only ticket-alignment todo that depends on every ordinary slice", async () => {
  const ticketAlignment = await writeTodosSection(ticketAlignmentHeading);
  assert.deepEqual(
    missingPhrases(ticketAlignment, [
      "the queue row carries a `TICKET:` block, or `00_overview.md` stamps `ticket:`",
      "It is a fresh real Shadow and **verdict-only**",
      "`--deliverable-shape verdict-only`",
      "its empty branch is expected",
      "Its `deps:` name every other ordinary slice",
      "deps: [<every other ordinary slice>]",
    ]),
    [],
  );
  const layout = await writeTodosSection("## Folder + filename layout");
  assert.ok(layout.includes("98_ticket_<topic>.md"));
  const writeTheFiles = await writeTodosSection("### 3. Write the files");
  assert.ok(writeTheFiles.includes("When the bundle is ticket-driven, write `98_ticket_<topic>.md`"));
  const overview = await writeTodosSection("## The overview file (`00_overview.md`)");
  assert.deepEqual(
    missingPhrases(overview, [
      "for a ticket-driven bundle `ticket: <key or URL>`",
      "ticket: <key or URL, only when the bundle is ticket-driven>",
    ]),
    [],
  );
});

test("the ticket-alignment todo runs the global ticket-check with the row's rulings and every amendment, and ends with a PASS or FAIL outcome line", async () => {
  const ticketAlignment = await writeTodosSection(ticketAlignmentHeading);
  assert.deepEqual(
    missingPhrases(ticketAlignment, [
      "It runs the global `/ticket-check` skill on the campaign branch candidate",
      "the row's `RULINGS:`, every queue amendment, and every source-turn amendment in `00_overview.md`",
      "It calls `/ticket-check` and never restates its procedure.",
      "`**Ticket alignment outcome:** PASS` or `**Ticket alignment outcome:** FAIL`",
      "is corrective work for the Alpha, exactly like a `99a` FAIL",
    ]),
    [],
  );
});

test("the ticket-alignment todo writes its differences and warning block to the bundle for delivery", async () => {
  const ticketAlignment = await writeTodosSection(ticketAlignmentHeading);
  assert.deepEqual(
    missingPhrases(ticketAlignment, [
      "it writes `ticket-warning.md` into the bundle folder",
      "`/ticket-check`'s DIFFERENT BY RULING lines plus its warning block verbatim",
      "or the single line `no warning needed`",
      "`99c` reads that file when it writes the pull request body",
    ]),
    [],
  );
});

test("conformance depends on the ticket-alignment todo and fails unless its outcome is PASS", async () => {
  const conformance = await writeTodosSection(conformanceHeading);
  assert.deepEqual(
    missingPhrases(conformance, [
      "`99a`'s `deps:` include it, and `99a` FAILs unless that todo's file carries `**Ticket alignment outcome:** PASS` on its own line",
      "deps: [<every ordinary slice, including 98_ticket_<topic> when it exists>]",
      "When this bundle has a `98_ticket_<topic>.md`, FAIL unless that file carries `**Ticket alignment outcome:** PASS` on its own line.",
    ]),
    [],
  );
});

test("the delivery todo puts the warning block in a Ticket Status section at the bottom of the pull request body", async () => {
  const delivery = await writeTodosSection(deliveryHeading);
  assert.deepEqual(
    missingPhrases(delivery, [
      "`99c` puts that block verbatim at the very bottom of the PR body, after `## Agents`, as the `## Ticket Status` section `/pr-description` describes",
      "`no warning needed` means the body has no `## Ticket Status` section at all.",
      "put that block verbatim at the very bottom of the PR body, after `## Agents`, as the `## Ticket Status` section `/pr-description` describes.",
      "When it reads `no warning needed`, the body has no `## Ticket Status` section at all.",
    ]),
    [],
  );
  assert.equal(delivery.includes("top of the PR body"), false);
});

test("the ticket-alignment numbering is documented beside the terminal filename rule", async () => {
  const delivery = await writeTodosSection(deliveryHeading);
  const terminalFilenameRule = delivery.indexOf("Keep the verb in every terminal filename");
  const numberingNote = delivery.indexOf("`98_ticket_<topic>` keeps its role word too.");
  assert.notEqual(terminalFilenameRule, -1);
  assert.ok(numberingNote > terminalFilenameRule);
  assert.deepEqual(
    missingPhrases(delivery.slice(numberingNote), [
      "It is the last ordinary-band number, so it runs after every other ordinary slice and before `99a`",
      "it is not one of the three terminal gates the throne classifies by verb",
    ]),
    [],
  );
});
