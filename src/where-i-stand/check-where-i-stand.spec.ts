import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AGENT_LIFECYCLE_STATES } from "../agent-statuses/agent-statuses.types.ts";
import { completionReportPathForAgent } from "../agentdata/ledger-data.service.ts";
import { runCompleteAgent } from "../complete-agent/complete-agent.ts";
import { resolveRegentQueueDatabasePath } from "../regent-queue/regent-queue-database.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import {
  judgeCampaignPageRecord,
  refuseCompletionWithoutPageRecord,
  type PageRecordPlaces,
} from "./campaign-page-record.ts";
import {
  CheckWhereIStandExitCode,
  runCheckWhereIStand,
} from "./check-where-i-stand-runtime.ts";
import { FRAME_HEADINGS, PageSection, sectionHeadingOf } from "./page-frame.ts";
import { JournalAction, readJournal } from "./page-journal.ts";
import { PAGE_FILE_NAME, showPage } from "./page-store.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";

const ALPHA = "alpha-bakery-01";
const OBJECTIVE_CODE = "bakery";
const SHADOW_OF_THE_ALPHA = "shadow-bakery-99c-deliver";
const ALPHA_OF_ANOTHER_CAMPAIGN = "alpha-florist-01";
const SHADOW_OF_ANOTHER_CAMPAIGN = "shadow-florist-01-bouquets";
const DELIVERED_AT = new Date("2026-10-14T09:00:00.000Z");
const BEFORE_DELIVERY = new Date("2026-10-14T08:00:00.000Z");
const AFTER_DELIVERY = new Date("2026-10-14T10:00:00.000Z");
const MAY_NOT_BE_COMPLETED = `"${ALPHA}" may not be completed yet: `;
const PAGE_EDIT_FLOW =
  '"throne where-i-stand show", then "throne where-i-stand lock --checksum <checksum>" run in the background, ' +
  'a targeted edit of that entry with your edit tool, and stopping the lock';
const LINKS_LINE = "- Links: Forgejo https://forge.example/bakery/pulls/7 · GitHub not on GitHub yet · Ticket no ticket";

async function places(t: TestContext): Promise<PageRecordPlaces> {
  const dataHome = await mkdtemp(path.join(tmpdir(), "check-where-i-stand-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const dataDir = path.join(dataHome, "data");
  await mkdir(dataDir);
  return { dataHome, dataDir };
}

async function ledgerFor(
  room: PageRecordPlaces,
  name: string,
  role: string,
  objectiveCode: string | undefined,
): Promise<string> {
  const ledger = path.join(room.dataDir, name);
  await mkdir(ledger, { recursive: true });
  await writeFile(path.join(ledger, "identity.md"), `# Identity — ${name}\n\n- **Role:** ${role}\n`);
  await writeFile(
    path.join(ledger, "spawn.json"),
    JSON.stringify({ harness: "claude", model: "opus", effort: 3, cwd: "/home/example", objective_code: objectiveCode }),
  );
  return ledger;
}

async function writeReport(room: PageRecordPlaces, alphaName: string, writtenAt: Date): Promise<void> {
  const report = completionReportPathForAgent(alphaName, room.dataDir);
  await writeFile(report, "# Report\n");
  await utimes(report, writtenAt, writtenAt);
}

async function deliveredAlpha(t: TestContext): Promise<PageRecordPlaces> {
  const room = await places(t);
  await ledgerFor(room, ALPHA, "Alpha", OBJECTIVE_CODE);
  await writeReport(room, ALPHA, DELIVERED_AT);
  return room;
}

interface EntryOnPage {
  readonly section: string;
  readonly identity: string;
  readonly body: string;
}

function pageWithEntries(entries: readonly EntryOnPage[]): string {
  return FRAME_HEADINGS.map(
    (heading) =>
      `${heading}\n` +
      entries
        .filter((entry) => sectionHeadingOf(entry.section) === heading)
        .map((entry) => `\n### ${entry.identity}\n\n${entry.body}\n`)
        .join(""),
  ).join("\n");
}

function pageWithEntry(section: string, identity: string, body: string): string {
  return pageWithEntries([{ section, identity, body }]);
}

async function writePage(
  t: TestContext,
  room: PageRecordPlaces,
  writer: string,
  writtenAt: Date,
  content: string,
): Promise<void> {
  const exitCode = await runWhereIStand(["lock", "--checksum", (await showPage(room.dataHome)).version], {
    dataHome: room.dataHome,
    currentAgentName: async () => writer,
    now: () => writtenAt,
    out: () => undefined,
    err: () => undefined,
    waitForRelease: () => writeFile(path.join(room.dataHome, PAGE_FILE_NAME), content, "utf8"),
    tellRegent: async () => undefined,
  });
  assert.equal(exitCode, WhereIStandExitCode.Done);
}

function recordDelivered(t: TestContext, room: PageRecordPlaces, writer: string, writtenAt: Date): Promise<void> {
  return writePage(
    t,
    room,
    writer,
    writtenAt,
    pageWithEntry(
      PageSection.DeliveredNotOnGitHub,
      OBJECTIVE_CODE,
      `${LINKS_LINE}\n\nThe order page is merged. Written by ${writer}.`,
    ),
  );
}

async function reasonRefused(room: PageRecordPlaces, agentName: string = ALPHA): Promise<string> {
  const verdict = await judgeCampaignPageRecord(agentName, room);
  assert.equal(verdict.recorded, false);
  return verdict.recorded ? "" : verdict.reason;
}

async function assertPasses(room: PageRecordPlaces, agentName: string = ALPHA): Promise<void> {
  assert.deepEqual(
    { ...(await judgeCampaignPageRecord(agentName, room)), summary: "" },
    { recorded: true, summary: "" },
  );
}

function abandonQueueRow(room: PageRecordPlaces, objectiveCode: string): void {
  const store = openRegentQueueStore(resolveRegentQueueDatabasePath(room.dataDir));
  try {
    store.insertItem({ objectiveCode, body: `INTENT: ${objectiveCode}` });
    store.transitionStatus(objectiveCode, RegentQueueItemStatus.InFlight);
    store.transitionStatus(objectiveCode, RegentQueueItemStatus.Abandoned);
  } finally {
    store.close();
  }
}

interface Completion {
  readonly exitCode: number;
  readonly reaped: readonly string[];
  readonly complaints: string;
}

async function completeAlpha(room: PageRecordPlaces, selector: string): Promise<Completion> {
  const reaped: string[] = [];
  let complaints = "";
  const exitCode = await runCompleteAgent([selector], {
    getRoster: async () => [
      { name: ALPHA, lifecycle: AGENT_LIFECYCLE_STATES.COMPLETE, reportLanded: true, focused: false },
    ],
    reap: async (name) => {
      reaped.push(name);
      return 0;
    },
    writeStdout: () => undefined,
    writeStderr: (text) => {
      complaints += text;
    },
    refuseCompletionWithoutPageRecord: (name) => refuseCompletionWithoutPageRecord(name, room),
  });
  return { exitCode, reaped, complaints };
}

test("an Alpha that recorded its outcome after delivery passes the check", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(t, room, ALPHA, AFTER_DELIVERY);
  const printed: string[] = [];
  const exitCode = await runCheckWhereIStand(["--agent", ALPHA], {
    places: room,
    out: (message) => void printed.push(message),
    err: () => undefined,
  });
  assert.equal(exitCode, CheckWhereIStandExitCode.Recorded);
  assert.match(printed.join(""), /^check-where-i-stand: recorded — "bakery" was recorded on the page/);
});

test("an Alpha whose entry is still under In flight is refused and told to move it", async (t) => {
  const room = await deliveredAlpha(t);
  await writePage(
    t,
    room,
    ALPHA,
    AFTER_DELIVERY,
    pageWithEntry(PageSection.InFlight, OBJECTIVE_CODE, "Still baking."),
  );
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}move the entry "### bakery" on the Lord's page out of "## In flight" to ` +
      '"## Delivered, not on GitHub" or "## On GitHub" with ' + PAGE_EDIT_FLOW + '.',
  );
});

test("a campaign whose delivered entry does not start with its links line may not be completed yet", async (t) => {
  const room = await deliveredAlpha(t);
  await writePage(
    t,
    room,
    ALPHA,
    AFTER_DELIVERY,
    pageWithEntry(PageSection.DeliveredNotOnGitHub, OBJECTIVE_CODE, `The order page is merged.\n${LINKS_LINE}`),
  );
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}start the entry "### bakery" on the Lord's page with its links line, ` +
      '`- Links: Forgejo <url or "no Forgejo copy"> · GitHub <url or "not on GitHub yet"> · Ticket <url, id, or "no ticket">`, ' +
      'or `- Links: no pull request · <commit or link> · Ticket <url, id, or "no ticket">` for work with no pull request, ' +
      'directly under its heading, with ' + PAGE_EDIT_FLOW + '.',
  );
  assert.equal((await completeAlpha(room, ALPHA)).exitCode, 1);
});

test("a campaign whose delivered entry starts with its links line is recorded", async (t) => {
  const room = await deliveredAlpha(t);
  await writePage(
    t,
    room,
    ALPHA,
    AFTER_DELIVERY,
    pageWithEntry(
      PageSection.OnGitHub,
      OBJECTIVE_CODE,
      "- Links: no pull request · commit 1a2b3c4 · Ticket BAKE-12\n- Kind: bug fix — oven timer\nMerged.",
    ),
  );
  await assertPasses(room);
});

test("an Alpha with no entry written after its delivery is refused and told what to write", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(t, room, ALPHA, BEFORE_DELIVERY);
  const complaints: string[] = [];
  const exitCode = await runCheckWhereIStand(["--agent", ALPHA], {
    places: room,
    out: () => undefined,
    err: (message) => void complaints.push(message),
  });
  assert.equal(exitCode, CheckWhereIStandExitCode.NotRecorded);
  assert.equal(
    complaints.join(""),
    `check-where-i-stand: ${MAY_NOT_BE_COMPLETED}record the campaign's outcome on the Lord's page by adding the entry ` +
      '"### bakery" under "## Delivered, not on GitHub" or "## On GitHub" with ' + PAGE_EDIT_FLOW + ', ' +
      "because no edit by this campaign since its REPORT.md names that entry.\n",
  );
});

test("an entry written by one of the Alpha's Shadows after delivery passes the check", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(t, room, SHADOW_OF_THE_ALPHA, AFTER_DELIVERY);
  await assertPasses(room);
});

test("an entry written by another campaign does not satisfy the check", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(t, room, ALPHA_OF_ANOTHER_CAMPAIGN, AFTER_DELIVERY);
  await writePage(
    t,
    room,
    SHADOW_OF_ANOTHER_CAMPAIGN,
    AFTER_DELIVERY,
    pageWithEntry(PageSection.OnGitHub, OBJECTIVE_CODE, "Moved by a stranger."),
  );
  assert.match(await reasonRefused(room), /no edit by this campaign since its REPORT\.md names that entry\.$/);
});

test("an Alpha that has not written its report yet is refused and told to write the report first", async (t) => {
  const room = await places(t);
  await ledgerFor(room, ALPHA, "Alpha", OBJECTIVE_CODE);
  await recordDelivered(t, room, ALPHA, AFTER_DELIVERY);
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}write its REPORT.md first, then record the campaign's outcome on the Lord's page ` +
      'as the entry "### bakery" with ' + PAGE_EDIT_FLOW + '.',
  );
});

test("an Alpha whose queue row was abandoned passes without an entry", async (t) => {
  const room = await places(t);
  await ledgerFor(room, ALPHA, "Alpha", OBJECTIVE_CODE);
  abandonQueueRow(room, OBJECTIVE_CODE);
  await assertPasses(room);
});

test("an agent that is not an Alpha passes without an entry", async (t) => {
  const room = await places(t);
  await ledgerFor(room, SHADOW_OF_THE_ALPHA, "Shadow", OBJECTIVE_CODE);
  await ledgerFor(room, "alpha-errand-01", "Alpha", undefined);
  await assertPasses(room, SHADOW_OF_THE_ALPHA);
  await assertPasses(room, "alpha-errand-01");
  await assertPasses(room, "stager-with-no-ledger");
});

test("an Alpha with no todo bundle is checked the same way", async (t) => {
  const room = await deliveredAlpha(t);
  assert.match(await reasonRefused(room), /record the campaign's outcome on the Lord's page/);
  await recordDelivered(t, room, ALPHA, AFTER_DELIVERY);
  await assertPasses(room);
});

test("a campaign that never wrote before delivery passes after one write", async (t) => {
  const room = await deliveredAlpha(t);
  assert.deepEqual(await readJournal(room.dataHome), []);
  await recordDelivered(t, room, ALPHA, AFTER_DELIVERY);
  assert.equal((await readJournal(room.dataHome)).length, 1);
  await assertPasses(room);
});

test("completing an Alpha is refused with the check's message while the check refuses", async (t) => {
  const room = await deliveredAlpha(t);
  const checkMessage = await reasonRefused(room);
  for (const selector of [ALPHA, "--all"]) {
    const completion = await completeAlpha(room, selector);
    assert.equal(completion.exitCode, 1);
    assert.deepEqual(completion.reaped, []);
    assert.equal(completion.complaints, `complete-agent: ${checkMessage}\n`);
  }
});

test("completing an Alpha proceeds once the check passes", async (t) => {
  const room = await deliveredAlpha(t);
  assert.deepEqual((await completeAlpha(room, ALPHA)).reaped, []);
  await recordDelivered(t, room, ALPHA, AFTER_DELIVERY);
  for (const selector of [ALPHA, "--all"]) {
    const completion = await completeAlpha(room, selector);
    assert.equal(completion.exitCode, 0);
    assert.deepEqual(completion.reaped, [ALPHA]);
    assert.equal(completion.complaints, "");
  }
});

test("check-where-i-stand refuses an unknown flag, a missing agent name or an empty one before reading anything", async (t) => {
  const room = await deliveredAlpha(t);
  for (const invocation of [["--agent", ALPHA, "--force"], [], ["--agent"], ["--agent", " "], [ALPHA]]) {
    const complaints: string[] = [];
    const exitCode = await runCheckWhereIStand(invocation, {
      places: room,
      out: () => undefined,
      err: (message) => void complaints.push(message),
    });
    assert.equal(exitCode, CheckWhereIStandExitCode.InvalidInvocation);
    assert.match(complaints.join(""), /usage: throne check-where-i-stand --agent <alpha name>/);
    assert.match(complaints.join(""), /No bypass is available for this refusal\./);
  }
});

const STAGER = "stager-bakery";
const LATER_STILL = new Date("2026-10-14T11:00:00.000Z");
const FORGEJO_PULL = "https://forge.example/bakery/pulls/7";
const GITHUB_PULL = "https://github.example/bakery/storefront/pull/31";
const BOTH_PULLS = `- Links: Forgejo ${FORGEJO_PULL} · GitHub ${GITHUB_PULL} · Ticket no ticket`;
const STILL_WAITING = "- Where it stands: GitHub #31 ready, CI green, waiting on review, still at 0a1b2c3.";

function onGitHub(identity: string, linksLine: string, rest: string): EntryOnPage {
  return { section: PageSection.OnGitHub, identity, body: `${linksLine}\n${rest}` };
}

const OLDER_ENTRY = onGitHub("crumb", BOTH_PULLS, STILL_WAITING);
const DELIVERING_ENTRY = onGitHub(OBJECTIVE_CODE, BOTH_PULLS, "- Where it stands: squash-merged into trunk as 9f8e7d6.");

async function deliveredBeside(
  t: TestContext,
  older: EntryOnPage,
  delivering: EntryOnPage = DELIVERING_ENTRY,
): Promise<PageRecordPlaces> {
  const room = await deliveredAlpha(t);
  await writePage(t, room, STAGER, BEFORE_DELIVERY, pageWithEntries([older]));
  await writePage(t, room, ALPHA, AFTER_DELIVERY, pageWithEntries([older, delivering]));
  return room;
}

test("the page check refuses while an older entry about the same pull request still says an older state", async (t) => {
  const room = await deliveredBeside(t, OLDER_ENTRY);
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}correct the older entries about the same work as "### bakery" on the Lord's page: ` +
      `"### crumb" still says "${STILL_WAITING}". Remove each one, or correct that line and add the line ` +
      '"Superseded by `### bakery` on <date>", with ' + PAGE_EDIT_FLOW + '.',
  );
  assert.equal((await completeAlpha(room, ALPHA)).exitCode, 1);
});

test("the page check passes once the older entry about the same work is removed", async (t) => {
  const room = await deliveredBeside(t, OLDER_ENTRY);
  await writePage(t, room, ALPHA, LATER_STILL, pageWithEntries([DELIVERING_ENTRY]));
  await assertPasses(room);
});

test("the page check passes once the older entry about the same work says it is superseded", async (t) => {
  for (const supersededLine of ["Superseded by `### bakery` on 2026-10-14.", "- Superseded by `### bakery` on 2026-10-14."]) {
    await assertPasses(await deliveredBeside(t, onGitHub("crumb", BOTH_PULLS, `${STILL_WAITING}\n${supersededLine}`)));
  }
});

test("an older entry that carries only the Forgejo link is matched through the twin the delivering entry carries", async (t) => {
  const forgejoOnly = `- Links: Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket no ticket`;
  const room = await deliveredBeside(t, onGitHub("crumb", forgejoOnly, STILL_WAITING));
  assert.match(await reasonRefused(room), /"### crumb" still says/);
});

test("a Forgejo-only entry and a GitHub-only entry are matched through another entry that carries both", async (t) => {
  const room = await deliveredAlpha(t);
  const older = [
    onGitHub("crumb", `- Links: Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket no ticket`, STILL_WAITING),
    onGitHub("icing", BOTH_PULLS, "Superseded by `### bakery` on 2026-10-14."),
  ];
  const githubOnly = `- Links: Forgejo no Forgejo copy · GitHub ${GITHUB_PULL} · Ticket no ticket`;
  await writePage(t, room, STAGER, BEFORE_DELIVERY, pageWithEntries(older));
  await writePage(t, room, ALPHA, AFTER_DELIVERY, pageWithEntries([...older, onGitHub(OBJECTIVE_CODE, githubOnly, "Merged.")]));
  assert.match(await reasonRefused(room), /: "### crumb" still says "[^"]+"\. Remove/);
});

test("entries with no pull request match on the same ticket and the same commit", async (t) => {
  const noPullRequest = "- Links: no pull request · commit 1a2b3c4 · Ticket BAKE-12";
  const room = await deliveredBeside(
    t,
    onGitHub("crumb", noPullRequest, STILL_WAITING),
    onGitHub(OBJECTIVE_CODE, noPullRequest, "- Where it stands: merged."),
  );
  assert.match(await reasonRefused(room), /"### crumb" still says/);
});

test("entries about other work never trip the page check", async (t) => {
  const otherWork: readonly (readonly [string, string])[] = [
    [BOTH_PULLS, "- Links: Forgejo https://forge.example/bakery/pulls/8 · GitHub not on GitHub yet · Ticket no ticket"],
    ["- Links: no pull request · commit 1a2b3c4 · Ticket BAKE-12", "- Links: no pull request · commit 1a2b3c4 · Ticket BAKE-13"],
    ["- Links: no pull request · commit 1a2b3c4 · Ticket BAKE-12", "- Links: no pull request · commit 5d6e7f8 · Ticket BAKE-12"],
    ["- Links: no pull request · commit 1a2b3c4 · Ticket no ticket", "- Links: no pull request · commit 1a2b3c4 · Ticket no ticket"],
    [`- Links: Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket BAKE-12`, "- Links: no pull request · commit 1a2b3c4 · Ticket BAKE-12"],
  ];
  for (const [deliveringLinks, olderLinks] of otherWork) {
    const delivering = onGitHub(OBJECTIVE_CODE, deliveringLinks, "- Where it stands: merged.");
    await assertPasses(await deliveredBeside(t, onGitHub("crumb", olderLinks, STILL_WAITING), delivering));
  }
});

test("an entry about the same work written after the campaign's own entry does not trip the page check", async (t) => {
  const room = await deliveredAlpha(t);
  await writePage(t, room, ALPHA, AFTER_DELIVERY, pageWithEntries([DELIVERING_ENTRY]));
  await writePage(t, room, STAGER, LATER_STILL, pageWithEntries([OLDER_ENTRY, DELIVERING_ENTRY]));
  await assertPasses(room);
});

test("a pull request link followed by a note in brackets still names that pull request", async (t) => {
  const forgejoOnly = `- Links: Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket no ticket`;
  const closedTwin = `- Links: Forgejo ${FORGEJO_PULL} (closed) · GitHub ${GITHUB_PULL} · Ticket no ticket`;
  const delivering = onGitHub(OBJECTIVE_CODE, closedTwin, "- Where it stands: merged.");
  const room = await deliveredBeside(t, onGitHub("crumb", forgejoOnly, STILL_WAITING), delivering);
  assert.match(await reasonRefused(room), /"### crumb" still says/);
});

test("check-where-i-stand passes on a delivery recorded with lock, edit and release", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(t, room, ALPHA, AFTER_DELIVERY);
  const release = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([release?.action, release?.writer, release?.added], [JournalAction.Edit, ALPHA, [OBJECTIVE_CODE]]);
  await assertPasses(room);
});

test("check-where-i-stand's refusal names the new flow", async (t) => {
  const room = await deliveredAlpha(t);
  const reason = await reasonRefused(room);
  assert.match(reason, /"throne where-i-stand show", then "throne where-i-stand lock --checksum <checksum>" run in the background/);
  assert.match(reason, /a targeted edit of that entry with your edit tool, and stopping the lock/);
  assert.doesNotMatch(reason, /where-i-stand write/);
});
