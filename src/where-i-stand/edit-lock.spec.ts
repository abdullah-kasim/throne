import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { EMPTY_FRAME, listEntries, versionOf } from "./page-frame.ts";
import { JournalAction, readJournal } from "./page-journal.ts";
import { pagePathIn, previousCopyPathIn } from "./page-store.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import {
  dependenciesThatEditWhileHeld,
  editThePageDirectly,
  entry,
  filesBesideThePage,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  WRITER,
  WRITTEN_AT,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const FIVE_MINUTES_LATER = new Date(WRITTEN_AT.getTime() + 5 * 60 * 1000).toISOString();
const OTHER_WRITER = "alpha-florist-01";

async function roomWithOneEntryJournaled(t: TestContext): Promise<{ room: PageRoom; recordsBefore: number }> {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => pageWith({ "## In flight": entry("ovenqueue", "Baking.") }));
  return { room, recordsBefore: (await readJournal(room.dataHome)).length };
}

function entryBodiesByIdentity(content: string): Map<string, string> {
  return new Map(listEntries(content).map((pageEntry) => [pageEntry.identity, pageEntry.body]));
}

test("an agent's targeted edit of its own entry under the lock leaves every other entry byte-identical", async (t) => {
  const room = await pageRoom(t);
  const othersInFlight = ["ovenqueue", "tillreport", "breadlabels", "flourorder"];
  const writersOwnBody = "The page lock is being built.";
  const before = pageWith({
    "## In flight":
      entry("pagelock", writersOwnBody) +
      othersInFlight.map((identity) => entry(identity, `- Links: no pull request · ${identity} · Ticket no ticket\n\n${identity} is in flight.`)).join(""),
  });
  await lockEditAndRelease(room, () => before);

  const exitCode = await lockEditAndRelease(room, (content) =>
    content.replace(writersOwnBody, "The page lock is built and delivered."),
  );

  assert.equal(exitCode, WhereIStandExitCode.Done);
  const bodiesBefore = entryBodiesByIdentity(before);
  const bodiesAfter = entryBodiesByIdentity(await readPageOrEmptyFrame(room));
  for (const identity of othersInFlight) assert.equal(bodiesAfter.get(identity), bodiesBefore.get(identity));
  const release = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([release?.added, release?.changed, release?.removed], [[], ["pagelock"], []]);
});

test("a lock based on an older page is refused and writes nothing", async (t) => {
  const room = await pageRoom(t);
  const current = pageWith({ "## In flight": entry("ovenqueue", "Baking.") });
  await lockEditAndRelease(room, () => current);
  const before = await filesBesideThePage(room);
  let holds = 0;

  const exitCode = await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], {
    ...room.dependencies,
    waitForRelease: async () => void (holds += 1),
  });

  assert.equal(exitCode, WhereIStandExitCode.Refused);
  assert.equal(holds, 0);
  assert.match(room.complaints.join(""), new RegExp(`its checksum is now ${versionOf(current)}`));
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("while the lock is held its process prints one line naming the holder and until when, for five minutes unless told otherwise", async (t) => {
  const room = await pageRoom(t);
  let printedWhileHeld: string[] = [];

  await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], {
    ...room.dependencies,
    waitForRelease: async () => void (printedWhileHeld = [...room.printed, ...room.complaints]),
  });

  assert.equal(printedWhileHeld.length, 1);
  assert.equal(printedWhileHeld[0]?.split("\n").length, 2);
  assert.match(printedWhileHeld[0] ?? "", new RegExp(`^where-i-stand: locked by ${WRITER} until ${FIVE_MINUTES_LATER}\\. `));
});

test("a lock longer than fifteen minutes is refused", async (t) => {
  const room = await pageRoom(t);
  const outcomes: Record<string, number> = {};

  for (const duration of ["16m", "901s", "15m"]) {
    outcomes[duration] = await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME), "--ttl", duration], room.dependencies);
  }

  assert.deepEqual(outcomes, {
    "16m": WhereIStandExitCode.InvalidInvocation,
    "901s": WhereIStandExitCode.InvalidInvocation,
    "15m": WhereIStandExitCode.Done,
  });
  assert.match(room.complaints.join(""), /--ttl may be at most 15m, got "16m"/);
});

test("a second lock or a note while a lock is held is refused naming the holder", async (t) => {
  const room = await pageRoom(t);
  const otherComplaints: string[] = [];
  const other = {
    ...room.dependencies,
    currentAgentName: async () => OTHER_WRITER,
    err: (message: string) => void otherComplaints.push(message),
  };
  let refusedWhileHeld: number[] = [];

  await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], {
    ...room.dependencies,
    waitForRelease: async () => {
      refusedWhileHeld = [
        await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], other),
        await runWhereIStand(["note", "launched florist"], other),
      ];
    },
  });

  assert.deepEqual(refusedWhileHeld, [WhereIStandExitCode.Refused, WhereIStandExitCode.Refused]);
  assert.equal(otherComplaints.length, 2);
  for (const complaint of otherComplaints) {
    assert.match(complaint, new RegExp(`edit lock is held by ${WRITER} until ${FIVE_MINUTES_LATER}`));
  }
  assert.equal(await readPageOrEmptyFrame(room), EMPTY_FRAME);
  assert.deepEqual((await readJournal(room.dataHome)).map((record) => record.writer), []);
});

test("the lock never blocks editing the page directly", async (t) => {
  const room = await pageRoom(t);
  const edited = pageWith({ "## In flight": entry("ovenqueue", "Edited while the lock is held.") });
  let readBackWhileHeld = "";

  await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], {
    ...room.dependencies,
    waitForRelease: async () => {
      await writeFile(pagePathIn(room.dataHome), edited, "utf8");
      readBackWhileHeld = await readFile(pagePathIn(room.dataHome), "utf8");
    },
  });

  assert.equal(readBackWhileHeld, edited);
});

test("showing the page while a lock is held does not call the edit in progress unrecorded", async (t) => {
  const { room, recordsBefore } = await roomWithOneEntryJournaled(t);

  await runWhereIStand(["lock", "--checksum", versionOf(await readPageOrEmptyFrame(room))], {
    ...room.dependencies,
    waitForRelease: async () => {
      await editThePageDirectly(room, (content) => content.replace("Baking.", "Baked."));
      await runWhereIStand(["show"], room.dependencies);
    },
  });

  const journal = await readJournal(room.dataHome);
  assert.deepEqual(journal.slice(recordsBefore).map((record) => record.action), [JournalAction.Edit]);
  assert.deepEqual(room.regentNotices, []);
});

test("releasing the lock journals the edit against the copy saved at lock time", async (t) => {
  const room = await pageRoom(t);
  const atLockTime = pageWith({ "## In flight": entry("ovenqueue", "Baking.") + entry("tillreport", "Counting.") });
  await lockEditAndRelease(room, () => atLockTime);

  await runWhereIStand(["lock", "--checksum", versionOf(atLockTime)], {
    ...room.dependencies,
    waitForRelease: async () => {
      await editThePageDirectly(room, (content) => content.replace("Baking.", "Baked."));
      await editThePageDirectly(room, (content) => content.replace(entry("tillreport", "Counting."), ""));
    },
  });

  assert.equal(await readFile(previousCopyPathIn(room.dataHome, 1), "utf8"), atLockTime);
  const release = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual(
    [release?.writer, release?.action, release?.changed, release?.removed],
    [WRITER, JournalAction.Edit, ["ovenqueue"], ["tillreport"]],
  );
  assert.equal(release?.version, versionOf(await readPageOrEmptyFrame(room)));
});

test("a lock-release record matches the record a whole-page write made for the same change", async (t) => {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () =>
    pageWith({
      "## In flight": entry("ovenqueue", "Baking.") + entry("tillreport", "Counting."),
      "## Queued and deferred": entry("breadlabels", "Waiting."),
    }),
  );
  const second = pageWith({
    "## In flight": entry("ovenqueue", "Baked and cooling.") + entry("tillreport", "Counting."),
    "## On GitHub": entry("example/shop#42", "Open."),
  });

  await lockEditAndRelease(room, () => second);

  const recordTheWholePageWriteMade = {
    at: WRITTEN_AT.toISOString(),
    writer: WRITER,
    action: JournalAction.Write,
    version: versionOf(second),
    added: ["example/shop#42"],
    changed: ["ovenqueue"],
    removed: ["breadlabels"],
  };
  assert.deepEqual((await readJournal(room.dataHome)).at(-1), { ...recordTheWholePageWriteMade, action: JournalAction.Edit });
  assert.match(room.printed.join(""), /Journaled the edit: added example\/shop#42; changed ovenqueue; removed breadlabels\./);
});

test("a lock released with the page unchanged journals nothing", async (t) => {
  const { room, recordsBefore } = await roomWithOneEntryJournaled(t);

  assert.equal(await lockEditAndRelease(room, (content) => content), WhereIStandExitCode.Done);

  assert.equal((await readJournal(room.dataHome)).length, recordsBefore);
  assert.match(room.printed.join(""), /The page did not change, so nothing was journaled/);
});

test("a broken frame at release is reported with the saved copy and the Regent is told, and the page is left as it is", async (t) => {
  const room = await pageRoom(t);
  const atLockTime = pageWith({ "## In flight": entry("ovenqueue", "Baking.") });
  await lockEditAndRelease(room, () => atLockTime);
  const broken = atLockTime.replace("## Needs you\n", "");

  const exitCode = await runWhereIStand(
    ["lock", "--checksum", versionOf(atLockTime)],
    dependenciesThatEditWhileHeld(room, () => broken),
  );

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  assert.equal(await readPageOrEmptyFrame(room), broken);
  const savedCopy = previousCopyPathIn(room.dataHome, 1);
  assert.equal(await readFile(savedCopy, "utf8"), atLockTime);
  assert.match(room.complaints.join(""), /the heading "## Needs you" is missing/);
  assert.match(room.complaints.join(""), new RegExp(`the copy saved when the lock was taken is ${savedCopy}`));
  assert.equal(room.regentNotices.length, 1);
  assert.match(room.regentNotices[0] ?? "", new RegExp(`${WRITER} released the page's edit lock with faults to fix`));
  assert.match(room.regentNotices[0] ?? "", /the heading "## Needs you" is missing/);
  assert.equal((await readJournal(room.dataHome)).at(-1)?.action, JournalAction.Edit);
});

test("a Regent who cannot be told never changes how the lock ends", async (t) => {
  const room = await pageRoom(t, {
    tellRegent: async () => {
      throw new Error("send-agent is not reachable");
    },
  });

  const exitCode = await lockEditAndRelease(room, () => EMPTY_FRAME.replace("## Needs you\n", ""));

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  assert.match(room.complaints.join(""), /the Regent could not be told \(send-agent is not reachable\)/);
});

const FORGEJO_PULL_REQUEST = "https://forge.example/bakery/till/pulls/7";
const GITHUB_PULL_REQUEST = "https://github.com/bakery/till/pull/7";

function workEntry(identity: string, links: string, whereItStands: string, extra = ""): string {
  return entry(identity, `- Links: ${links} · Ticket BAKE-12\n- Where it stands: ${whereItStands}${extra}`);
}

test("a release after an edit that leaves two current entries about one pull request exits 3 and names both headings", async (t) => {
  const room = await pageRoom(t);
  const atLockTime = pageWith({ "## In flight": workEntry("ovenqueue", `GitHub ${GITHUB_PULL_REQUEST}`, "baking.") });
  await lockEditAndRelease(room, () => atLockTime);
  const withDuplicate = pageWith({
    "## In flight": workEntry("ovenqueue", `GitHub ${GITHUB_PULL_REQUEST}`, "baking."),
    "## On GitHub": workEntry("ovenretry", `GitHub ${GITHUB_PULL_REQUEST}`, "out of the oven."),
  });

  const exitCode = await lockEditAndRelease(room, () => withDuplicate);

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  assert.equal(await readPageOrEmptyFrame(room), withDuplicate);
  const report = room.complaints.join("");
  assert.match(report, /"### ovenqueue" still says "- Where it stands: baking\." and "### ovenretry" still says "- Where it stands: out of the oven\."/);
  assert.match(report, /Superseded by `### <identity>` on <date>/);
  assert.equal(room.regentNotices.length, 1);
  assert.match(room.regentNotices[0] ?? "", new RegExp(`${WRITER} released the page's edit lock with faults to fix`));
  assert.match(room.regentNotices[0] ?? "", /"### ovenretry"/);
  assert.equal((await readJournal(room.dataHome)).at(-1)?.action, JournalAction.Edit);
});

test("a superseded entry, and a Needs you question beside the work's own entry, are not reported", async (t) => {
  const room = await pageRoom(t);
  const links = `GitHub ${GITHUB_PULL_REQUEST}`;

  const exitCode = await lockEditAndRelease(room, () =>
    pageWith({
      "## Needs you": workEntry("ovenretry — one stale reply on #7", links, "waiting on you."),
      "## In flight": workEntry("ovenretry", links, "baking."),
      "## On GitHub": workEntry("ovenqueue", links, "replaced.", "\n\nSuperseded by `### ovenretry` on 2026-10-14"),
    }),
  );

  assert.equal(exitCode, WhereIStandExitCode.Done);
  assert.deepEqual(room.complaints, []);
  assert.deepEqual(room.regentNotices, []);
});

test("two Needs you questions about the same work are reported", async (t) => {
  const room = await pageRoom(t);
  const links = `GitHub ${GITHUB_PULL_REQUEST}`;

  const exitCode = await lockEditAndRelease(room, () =>
    pageWith({
      "## Needs you":
        workEntry("ovenretry — one stale reply on #7", links, "waiting on you.") +
        workEntry("ovenretry — the second reply on #7", links, "waiting on you too."),
    }),
  );

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  assert.match(room.complaints.join(""), /"### ovenretry — one stale reply on #7" still says .* and "### ovenretry — the second reply on #7"/);
});

test("a Forgejo pull request and its GitHub twin written as two entries are one piece of work", async (t) => {
  const room = await pageRoom(t);

  const exitCode = await lockEditAndRelease(room, () =>
    pageWith({
      "## Needs you": workEntry("ovenretry — one stale reply", `Forgejo ${FORGEJO_PULL_REQUEST} · GitHub ${GITHUB_PULL_REQUEST}`, "waiting on you."),
      "## Delivered, not on GitHub": workEntry("ovenqueue", `Forgejo ${FORGEJO_PULL_REQUEST}`, "delivered."),
      "## On GitHub": workEntry("ovenretry", `GitHub ${GITHUB_PULL_REQUEST}`, "promoted."),
    }),
  );

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  const report = room.complaints.join("");
  assert.match(report, /These entries are about the same work: "### ovenqueue" still says "- Where it stands: delivered\." and "### ovenretry" still says "- Where it stands: promoted\."\./);
  assert.doesNotMatch(report, /one stale reply/);
});

test("an entry written again under the same heading in another section is reported", async (t) => {
  const room = await pageRoom(t);
  const links = `GitHub ${GITHUB_PULL_REQUEST}`;

  const exitCode = await lockEditAndRelease(room, () =>
    pageWith({
      "## In flight": workEntry("ovenqueue", links, "baking."),
      "## On GitHub": workEntry("ovenqueue", links, "out of the oven."),
    }),
  );

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  assert.match(room.complaints.join(""), /"### ovenqueue" still says "- Where it stands: baking\." and "### ovenqueue" still says "- Where it stands: out of the oven\."/);
});
