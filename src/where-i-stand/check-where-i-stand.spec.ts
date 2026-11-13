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
import { connectToWhereIStand } from "../where-i-stand-store/where-i-stand-client.ts";
import { WhereIStandStore } from "../where-i-stand-store/where-i-stand.store.ts";
import { runWhereIStand } from "./where-i-stand-runtime.ts";

const ALPHA = "alpha-bakery-01";
const OBJECTIVE_CODE = "bakery";
const SHADOW_OF_THE_ALPHA = "shadow-bakery-99c-deliver";
const ALPHA_OF_ANOTHER_CAMPAIGN = "alpha-florist-01";
const SHADOW_OF_ANOTHER_CAMPAIGN = "shadow-florist-01-bouquets";
const DELIVERED_AT = new Date("2026-10-14T09:00:00.000Z");
const BEFORE_DELIVERY = new Date("2026-10-14T08:00:00.000Z");
const AFTER_DELIVERY = new Date("2026-10-14T10:00:00.000Z");
const MAY_NOT_BE_COMPLETED = `"${ALPHA}" may not be completed yet: `;
const PAGE_EDIT_FLOW = "\"throne where-i-stand list\" and then \"throne where-i-stand put --code <code> --section-id <id> --listing-token <token> --text-file <file>\"";
const LINKS = "Forgejo https://forge.example/bakery/pulls/7 · GitHub not on GitHub yet · Ticket no ticket";
const DELIVERED = "Delivered, not on GitHub";
const ON_GITHUB = "On GitHub";
const IN_FLIGHT = "In flight";
const PAGE_TABS: readonly (readonly [string, readonly string[]])[] = [
  ["Now", ["Needs you", IN_FLIGHT]],
  ["Delivered", [DELIVERED]],
  ["Pull requests", [ON_GITHUB]],
  ["Epics", ["Epics"]],
];

interface Room extends PageRecordPlaces {
  readonly write: (writer: string, at: Date, entry: Entry) => Promise<string>;
  readonly archive: (writer: string, at: Date, rowId: string) => Promise<void>;
}

interface Entry {
  readonly section: string;
  readonly code: string;
  readonly links?: string;
  readonly whereItStands?: string;
}

async function places(t: TestContext): Promise<Room> {
  const dataHome = await mkdtemp(path.join(tmpdir(), "check-where-i-stand-"));
  const dataDir = path.join(dataHome, "data");
  await mkdir(dataDir);
  let now = BEFORE_DELIVERY;
  const store = new WhereIStandStore(dataHome, () => now);
  t.after(async () => {
    await store.onModuleDestroy();
    await rm(dataHome, { recursive: true, force: true });
  });
  for (const [tabName, sections] of PAGE_TABS) {
    const tab = await store.createTab({ name: tabName, listingToken: (await store.listing()).listingToken, writer: "throne" });
    for (const name of sections) {
      await store.createSection({ tabId: tab.tab!.id, name, listingToken: (await store.listing()).listingToken, writer: "throne" });
    }
  }
  return {
    dataHome,
    dataDir,
    write: async (writer, at, entry) => {
      now = at;
      const listing = await store.listing();
      const section = listing.sections.find((each) => each.name === entry.section)!;
      const row = { kind: "work" as const, code: entry.code, links: entry.links ?? LINKS, workKind: "feature — order page", whereItStands: entry.whereItStands ?? "merged" };
      const answer = await store.addRow({ sectionId: section.id, listingToken: listing.listingToken, writer, row });
      assert.equal(answer.outcome, "done", answer.message);
      return answer.row!.id;
    },
    archive: async (writer, at, rowId) => {
      now = at;
      assert.equal((await store.archiveRow(rowId, { writer })).outcome, "done");
    },
  };
}

async function ledgerFor(room: PageRecordPlaces, name: string, role: string, objectiveCode: string | undefined): Promise<string> {
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

async function deliveredAlpha(t: TestContext): Promise<Room> {
  const room = await places(t);
  await ledgerFor(room, ALPHA, "Alpha", OBJECTIVE_CODE);
  await writeReport(room, ALPHA, DELIVERED_AT);
  return room;
}

function recordDelivered(room: Room, writer: string, writtenAt: Date): Promise<string> {
  return room.write(writer, writtenAt, { section: DELIVERED, code: OBJECTIVE_CODE });
}

async function reasonRefused(room: PageRecordPlaces, agentName: string = ALPHA): Promise<string> {
  const verdict = await judgeCampaignPageRecord(agentName, room);
  assert.equal(verdict.recorded, false);
  return verdict.recorded ? "" : verdict.reason;
}

async function assertPasses(room: PageRecordPlaces, agentName: string = ALPHA): Promise<void> {
  assert.deepEqual({ ...(await judgeCampaignPageRecord(agentName, room)), summary: "" }, { recorded: true, summary: "" });
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
    getRoster: async () => [{ name: ALPHA, lifecycle: AGENT_LIFECYCLE_STATES.COMPLETE, reportLanded: true, focused: false }],
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
  await recordDelivered(room, ALPHA, AFTER_DELIVERY);
  const printed: string[] = [];
  const exitCode = await runCheckWhereIStand(["--agent", ALPHA], { places: room, out: (message) => void printed.push(message), err: () => undefined });
  assert.equal(exitCode, CheckWhereIStandExitCode.Recorded);
  assert.match(printed.join(""), /^check-where-i-stand: recorded — "bakery" was recorded on the page/);
});

test("an Alpha whose entry is still under In flight is refused and told to move it", async (t) => {
  const room = await deliveredAlpha(t);
  await room.write(ALPHA, AFTER_DELIVERY, { section: IN_FLIGHT, code: OBJECTIVE_CODE, whereItStands: "still baking" });
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}move the work entry "bakery" on the Lord's page out of "In flight" to ` +
      `"Delivered, not on GitHub" or "On GitHub" with ${PAGE_EDIT_FLOW}.`,
  );
});

test("an Alpha with no entry written after its delivery is refused and told what to write", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(room, ALPHA, BEFORE_DELIVERY);
  const complaints: string[] = [];
  const exitCode = await runCheckWhereIStand(["--agent", ALPHA], { places: room, out: () => undefined, err: (message) => void complaints.push(message) });
  assert.equal(exitCode, CheckWhereIStandExitCode.NotRecorded);
  assert.equal(
    complaints.join(""),
    `check-where-i-stand: ${MAY_NOT_BE_COMPLETED}record the campaign's outcome on the Lord's page by putting the work entry ` +
      `"bakery" under "Delivered, not on GitHub" or "On GitHub" with ${PAGE_EDIT_FLOW}, ` +
      "because no write by this campaign since its REPORT.md holds that entry.\n",
  );
});

test("an archived campaign entry does not count as its record", async (t) => {
  const room = await deliveredAlpha(t);
  const rowId = await recordDelivered(room, ALPHA, AFTER_DELIVERY);
  await room.archive(ALPHA, AFTER_DELIVERY, rowId);
  assert.match(await reasonRefused(room), /no write by this campaign since its REPORT\.md holds that entry/);
});

test("an entry written by one of the Alpha's Shadows after delivery passes the check", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(room, SHADOW_OF_THE_ALPHA, AFTER_DELIVERY);
  await assertPasses(room);
});

test("an entry last written by another campaign does not satisfy the check", async (t) => {
  const room = await deliveredAlpha(t);
  await recordDelivered(room, ALPHA_OF_ANOTHER_CAMPAIGN, AFTER_DELIVERY);
  assert.match(await reasonRefused(room), /no write by this campaign since its REPORT\.md holds that entry\.$/);
  await room.write(SHADOW_OF_ANOTHER_CAMPAIGN, AFTER_DELIVERY, { section: ON_GITHUB, code: OBJECTIVE_CODE, whereItStands: "moved by a stranger" });
  assert.match(await reasonRefused(room), /no write by this campaign since its REPORT\.md holds that entry\.$/);
});

test("an Alpha that has not written its report yet is refused and told to write the report first", async (t) => {
  const room = await places(t);
  await ledgerFor(room, ALPHA, "Alpha", OBJECTIVE_CODE);
  await recordDelivered(room, ALPHA, AFTER_DELIVERY);
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}write its REPORT.md first, then record the campaign's outcome on the Lord's page as the work entry "bakery" with ${PAGE_EDIT_FLOW}.`,
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
  await recordDelivered(room, ALPHA, AFTER_DELIVERY);
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
  await recordDelivered(room, ALPHA, AFTER_DELIVERY);
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
    const exitCode = await runCheckWhereIStand(invocation, { places: room, out: () => undefined, err: (message) => void complaints.push(message) });
    assert.equal(exitCode, CheckWhereIStandExitCode.InvalidInvocation);
    assert.match(complaints.join(""), /usage: throne check-where-i-stand --agent <alpha name>/);
    assert.match(complaints.join(""), /No bypass is available for this refusal\./);
  }
});

const STAGER = "stager-bakery";
const LATER_STILL = new Date("2026-10-14T11:00:00.000Z");
const FORGEJO_PULL = "https://forge.example/bakery/pulls/7";
const GITHUB_PULL = "https://github.example/bakery/storefront/pull/31";
const BOTH_PULLS = `Forgejo ${FORGEJO_PULL} · GitHub ${GITHUB_PULL} · Ticket no ticket`;
const STILL_WAITING = "GitHub #31 ready, CI green, waiting on review, still at 0a1b2c3.";
const OLDER_ENTRY: Entry = { section: ON_GITHUB, code: "crumb", links: BOTH_PULLS, whereItStands: STILL_WAITING };
const DELIVERING_ENTRY: Entry = { section: ON_GITHUB, code: OBJECTIVE_CODE, links: BOTH_PULLS, whereItStands: "squash-merged into trunk as 9f8e7d6." };

async function deliveredBeside(t: TestContext, older: Entry, delivering: Entry = DELIVERING_ENTRY): Promise<Room & { readonly olderRowId: string }> {
  const room = await deliveredAlpha(t);
  const olderRowId = await room.write(STAGER, BEFORE_DELIVERY, older);
  await room.write(ALPHA, AFTER_DELIVERY, delivering);
  return { ...room, olderRowId };
}

test("the page check refuses while an older entry about the same pull request still says an older state", async (t) => {
  const room = await deliveredBeside(t, OLDER_ENTRY);
  assert.equal(
    await reasonRefused(room),
    `${MAY_NOT_BE_COMPLETED}archive the older entries about the same work as "bakery" on the Lord's page: ` +
      `${room.olderRowId} "crumb" still says "${STILL_WAITING}". Archive each one with "throne where-i-stand archive <row id>".`,
  );
  assert.equal((await completeAlpha(room, ALPHA)).exitCode, 1);
});

test("the page check passes once the older entry about the same work is archived", async (t) => {
  const room = await deliveredBeside(t, OLDER_ENTRY);
  await room.archive(ALPHA, LATER_STILL, room.olderRowId);
  await assertPasses(room);
});

test("an older entry that carries only the Forgejo link is matched through the twin the delivering entry carries", async (t) => {
  const room = await deliveredBeside(t, { ...OLDER_ENTRY, links: `Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket no ticket` });
  assert.match(await reasonRefused(room), /"crumb" still says/);
});

test("a Forgejo-only entry and a GitHub-only entry are matched through another entry that carries both", async (t) => {
  const room = await deliveredAlpha(t);
  await room.write(STAGER, BEFORE_DELIVERY, { ...OLDER_ENTRY, links: `Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket no ticket` });
  const icing = await room.write(STAGER, BEFORE_DELIVERY, { ...OLDER_ENTRY, code: "icing" });
  await room.archive(STAGER, BEFORE_DELIVERY, icing);
  await room.write(STAGER, BEFORE_DELIVERY, { ...OLDER_ENTRY, code: "sprinkles" });
  await room.write(ALPHA, AFTER_DELIVERY, { ...DELIVERING_ENTRY, links: `Forgejo no Forgejo copy · GitHub ${GITHUB_PULL} · Ticket no ticket` });
  const reason = await reasonRefused(room);
  assert.match(reason, /"crumb" still says/);
  assert.doesNotMatch(reason, /"icing"/);
});

test("entries with no pull request match on the same ticket and the same commit", async (t) => {
  const noPullRequest = "no pull request · commit 1a2b3c4 · Ticket BAKE-12";
  const room = await deliveredBeside(t, { ...OLDER_ENTRY, links: noPullRequest }, { ...DELIVERING_ENTRY, links: noPullRequest });
  assert.match(await reasonRefused(room), /"crumb" still says/);
});

test("entries about other work never trip the page check", async (t) => {
  const otherWork: readonly (readonly [string, string])[] = [
    [BOTH_PULLS, "Forgejo https://forge.example/bakery/pulls/8 · GitHub not on GitHub yet · Ticket no ticket"],
    ["no pull request · commit 1a2b3c4 · Ticket BAKE-12", "no pull request · commit 1a2b3c4 · Ticket BAKE-13"],
    ["no pull request · commit 1a2b3c4 · Ticket BAKE-12", "no pull request · commit 5d6e7f8 · Ticket BAKE-12"],
    ["no pull request · commit 1a2b3c4 · Ticket no ticket", "no pull request · commit 1a2b3c4 · Ticket no ticket"],
    [`Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket BAKE-12`, "no pull request · commit 1a2b3c4 · Ticket BAKE-12"],
  ];
  for (const [deliveringLinks, olderLinks] of otherWork) {
    await assertPasses(await deliveredBeside(t, { ...OLDER_ENTRY, links: olderLinks }, { ...DELIVERING_ENTRY, links: deliveringLinks }));
  }
});

test("an entry about the same work written after the campaign's own entry does not trip the page check", async (t) => {
  const room = await deliveredAlpha(t);
  await room.write(ALPHA, AFTER_DELIVERY, DELIVERING_ENTRY);
  await room.write(STAGER, LATER_STILL, OLDER_ENTRY);
  await assertPasses(room);
});

test("a pull request link followed by a note in brackets still names that pull request", async (t) => {
  const forgejoOnly = `Forgejo ${FORGEJO_PULL} · GitHub not on GitHub yet · Ticket no ticket`;
  const closedTwin = `Forgejo ${FORGEJO_PULL} (closed) · GitHub ${GITHUB_PULL} · Ticket no ticket`;
  const room = await deliveredBeside(t, { ...OLDER_ENTRY, links: forgejoOnly }, { ...DELIVERING_ENTRY, links: closedTwin });
  assert.match(await reasonRefused(room), /"crumb" still says/);
});

test("check-where-i-stand's refusal names put as the way to record the entry", async (t) => {
  const room = await deliveredAlpha(t);
  assert.match(await reasonRefused(room), /"throne where-i-stand put --code <code> --section-id <id> --listing-token <token> --text-file <file>"/);
});

test("B6.4 B7.7 check-where-i-stand passes with no backend for a campaign that recorded its delivery with put", async (t) => {
  const room = await deliveredAlpha(t);
  const connection = connectToWhereIStand({ local: true, throneHome: room.dataHome });
  const listing = await connection.operations.listing();
  await connection.close();
  const delivered = listing.sections.find((section) => section.name === DELIVERED)!.id;
  const exitCode = await runWhereIStand(
    ["put", "--local", "--code", OBJECTIVE_CODE, "--section-id", delivered, "--listing-token", listing.listingToken, `--text=- Links: ${LINKS}\n- Kind: Order page\n- Where it stands: merged.`],
    {
      connect: () => connectToWhereIStand({ local: true, throneHome: room.dataHome }),
      currentAgentName: async () => ALPHA,
      out: () => undefined,
      err: (message) => assert.fail(message),
    },
  );
  assert.equal(exitCode, 0);
  const complaints: string[] = [];
  assert.equal(
    await runCheckWhereIStand(["--agent", ALPHA], { places: room, out: () => undefined, err: (message) => void complaints.push(message) }),
    CheckWhereIStandExitCode.Recorded,
    complaints.join(""),
  );
});
