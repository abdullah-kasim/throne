import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { missingPhrases, readMarkdownSection } from "./skill-contract-test-helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BODY_HEADING = "## Body — five sections, in this order";
const AGENTS_HEADING = "### `## Agents`";
const TICKET_STATUS_HEADING = "### `## Ticket Status` (only when the PR differs from its ticket)";
const TICKET_STATUS_BLOCK = [
  "## Ticket Status",
  "",
  "<details>",
  "<summary>⚠️ This PR differs from the ticket in <N> ways</summary>",
  "",
  "**This PR differs from the ticket.** Reviewers, check these before approving:",
  "",
  '1. **Ticket asks:** "<the ticket\'s exact words>" — **This PR does:** <what it does instead> — **Why:** <the ruling, quoted, with who and when>.',
  "2. …",
  "",
  "</details>",
].join("\n");

async function readPullRequestDescriptionSkill(): Promise<string> {
  return readFile(path.join(ROOT, ".claude/skills/pr-description/SKILL.md"), "utf8");
}

function unwrap(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}

async function readBodySubsection(heading: string): Promise<string> {
  const section = readMarkdownSection(readMarkdownSection(await readPullRequestDescriptionSkill(), BODY_HEADING), heading);
  assert.notEqual(section, "", `pr-description has no ${heading} subsection under its body sections`);
  return section;
}

async function readReferenceExample(): Promise<string> {
  const example = readMarkdownSection(await readPullRequestDescriptionSkill(), "## Reference example");
  assert.notEqual(example, "", "pr-description has no reference example");
  return example;
}

test("a pull request that differs from its ticket closes with a hidden Ticket Status section after Agents", async () => {
  const body = readMarkdownSection(await readPullRequestDescriptionSkill(), BODY_HEADING);
  assert.ok(body.indexOf(AGENTS_HEADING) !== -1, "pr-description has no Agents subsection");
  assert.ok(body.indexOf(AGENTS_HEADING) < body.indexOf(TICKET_STATUS_HEADING), "the Ticket Status subsection comes after Agents");
  const ticketStatus = unwrap(await readBodySubsection(TICKET_STATUS_HEADING));
  assert.deepEqual(
    missingPhrases(ticketStatus, [
      "When `/ticket-check` reports any DIFFERENT BY RULING line",
      "the body closes with a `## Ticket Status` section that says so.",
      "It is the very bottom of the body, after `## Agents`; nothing follows it.",
      "The `Ticket:` line stays at the top.",
      "Paste `/ticket-check`'s block exactly as it prints it.",
      "`ticket-warning.md`",
    ]),
    [],
  );
  const agents = unwrap(await readBodySubsection(AGENTS_HEADING)).trimStart();
  assert.ok(
    agents.startsWith("The last section of the body, after `## Testing`, unless a `## Ticket Status` section follows it and closes the body."),
    "the Agents subsection yields the last place to Ticket Status",
  );
});

test("the ticket status block is a spoiler whose summary counts the differences", async () => {
  const ticketStatus = await readBodySubsection(TICKET_STATUS_HEADING);
  assert.ok(ticketStatus.includes("```markdown\n" + TICKET_STATUS_BLOCK + "\n```"), "the Ticket Status block is not the agreed block");
  assert.deepEqual(
    missingPhrases(unwrap(ticketStatus), [
      '**`<N>` counts the DIFFERENT BY RULING lines.** Write "1 way" when there is one.',
      "**The blank line after `</summary>` and the one before `</details>` are mandatory.** GitHub only renders markdown inside an HTML block when blank lines surround it",
    ]),
    [],
  );
});

test("the ticket status section uses plain bold text, never a GitHub alert", async () => {
  const ticketStatus = await readBodySubsection(TICKET_STATUS_HEADING);
  assert.ok(!TICKET_STATUS_BLOCK.includes("[!"), "the agreed block carries alert syntax");
  assert.deepEqual(
    missingPhrases(unwrap(ticketStatus), [
      "**Plain bold text, never a GitHub alert.** No `> [!WARNING]` or any other alert syntax anywhere in the section.",
      "renders an alert inside `<details>` as a plain quote with a literal `[!WARNING]`, so the section uses plain bold text on every host.",
    ]),
    [],
  );
});

test("each difference names the ticket's exact words, what the pull request does instead, and the ruling with who and when", async () => {
  const ticketStatus = unwrap(await readBodySubsection(TICKET_STATUS_HEADING));
  assert.deepEqual(
    missingPhrases(ticketStatus, [
      "**One numbered entry per difference, nothing omitted.**",
      "the ruling quoted, with who gave it and when",
      '**No softening words** such as "slightly", "minor" or "small".',
    ]),
    [],
  );
  const skill = unwrap(await readPullRequestDescriptionSkill());
  assert.ok(
    skill.includes("No em-dashes, except the separators inside the `## Ticket Status` block, which is pasted exactly as `/ticket-check` prints it."),
    "the plain-prose rule exempts the pasted Ticket Status block's separators",
  );
});

test("a pull request that matches its ticket has no Ticket Status section", async () => {
  const ticketStatus = unwrap(await readBodySubsection(TICKET_STATUS_HEADING));
  assert.deepEqual(
    missingPhrases(ticketStatus, [
      "**No differences, no section.** When `/ticket-check` reports none (`no warning needed`), the body has no `## Ticket Status` at all and `## Agents` closes it.",
    ]),
    [],
  );
});

test("the reference example opens with the ticket line and ends with a Ticket Status section after Agents", async () => {
  const example = (await readReferenceExample()).trimStart();
  assert.match(example, /^````markdown\nTicket: .+\n\n## What\n/);
  assert.ok(!example.includes("[!WARNING]\n> **This PR differs"), "the reference example still opens with an alert");
  const closing = /\n## Agents\n\n<details>\n[\s\S]*\n<\/details>\n\n## Ticket Status\n\n<details>\n<summary>⚠️ This PR differs from the ticket in (\d+) ways<\/summary>\n\n\*\*This PR differs from the ticket\.\*\* Reviewers, check these before approving:\n\n((?:.+\n)+)\n<\/details>\n````\s*$/.exec(example);
  assert.ok(closing, "the reference example does not end with a Ticket Status spoiler after Agents");
  const ticketStatus = closing[0].slice(closing[0].indexOf("## Ticket Status"));
  assert.ok(!ticketStatus.includes("[!"), "the reference example's Ticket Status section carries alert syntax");
  const entries = closing[2].trimEnd().split("\n");
  assert.equal(Number(closing[1]), entries.length, "the summary counts the entries");
  entries.forEach((entry, index) => {
    assert.match(entry, new RegExp(`^${index + 1}\\. \\*\\*Ticket asks:\\*\\* ".+" — \\*\\*This PR does:\\*\\* .+ — \\*\\*Why:\\*\\* ".+" \\(.+, \\d{4}-\\d{2}-\\d{2}\\)\\.$`));
  });
});
