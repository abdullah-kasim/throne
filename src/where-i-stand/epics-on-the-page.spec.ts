import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { EditLockOutcome, releaseEditLock, takeEditLock } from "./edit-lock.ts";
import { EMPTY_FRAME, versionOf } from "./page-frame.ts";
import { JournalAction, readJournal } from "./page-journal.ts";
import { previousCopyPathIn } from "./page-store.ts";
import { groupsOfTheSameWork } from "./same-work-entries.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import {
  editThePageDirectly,
  entry,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  WRITER,
  WRITTEN_AT,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const EPICS_AT_THE_END = "\n## Epics\n";
const OVEN_QUEUE = "### ovenqueue\n\nThe oven queue is baking.";
const PAGE_WITH_EPICS = pageWith({ "## In flight": `\n${OVEN_QUEUE}\n`, "## On GitHub": entry("tillreport", "Open.") });
const PAGE_WITHOUT_EPICS = PAGE_WITH_EPICS.slice(0, -EPICS_AT_THE_END.length);
const SECOND_BAKERY = "### Open the second bakery\n\nFind a site near the station.";
const SAME_LINK = "- Links: no pull request · flourdeal · Ticket BAKE-7";

async function roomWithPage(t: TestContext, page: string): Promise<PageRoom> {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => page);
  room.printed.length = 0;
  room.complaints.length = 0;
  room.regentNotices.length = 0;
  return room;
}

function saveFromThePage(room: PageRoom, loaded: string, edited: string): Promise<number> {
  return runWhereIStand(["save"], {
    ...room.dependencies,
    readStandardInput: async () => JSON.stringify({ loaded, edited }),
  });
}

test("a new page holds Epics as its last section", async (t) => {
  const room = await pageRoom(t);

  assert.equal(await runWhereIStand(["show"], room.dependencies), WhereIStandExitCode.Done);

  assert.deepEqual(room.printed.join("").split("\n").filter((line) => line !== ""), [
    "## Just happened",
    "## Needs you",
    "## In flight",
    "## Queued and deferred",
    "## Delivered, not on GitHub",
    "## On GitHub",
    "## Epics",
  ]);
});

test("an existing page without Epics gains the section on the next command and keeps every entry", async (t) => {
  const commands: Record<string, (room: PageRoom) => Promise<number>> = {
    show: (room) => runWhereIStand(["show"], room.dependencies),
    lock: (room) => runWhereIStand(["lock", "--checksum", versionOf(PAGE_WITH_EPICS)], room.dependencies),
    save: (room) => saveFromThePage(room, "## Epics", `## Epics\n\n${SECOND_BAKERY}`),
  };
  for (const [name, command] of Object.entries(commands)) {
    const room = await roomWithPage(t, PAGE_WITHOUT_EPICS);

    assert.equal(await command(room), WhereIStandExitCode.Done, name);

    const expected = name === "save" ? PAGE_WITH_EPICS.replace("## Epics\n", `## Epics\n\n${SECOND_BAKERY}\n`) : PAGE_WITH_EPICS;
    assert.equal(await readPageOrEmptyFrame(room), expected, name);
  }

  const room = await roomWithPage(t, PAGE_WITHOUT_EPICS);
  assert.equal(await runWhereIStand(["note", "launched ovenqueue"], room.dependencies), WhereIStandExitCode.Done);
  assert.equal(
    await readPageOrEmptyFrame(room),
    PAGE_WITH_EPICS.replace("## Just happened\n\n", "## Just happened\n\n- launched ovenqueue\n\n"),
  );
});

test("an existing page gains Epics with a previous copy kept and a journal row", async (t) => {
  const room = await roomWithPage(t, PAGE_WITHOUT_EPICS);

  await runWhereIStand(["show"], room.dependencies);

  assert.equal(room.printed.join(""), PAGE_WITH_EPICS);
  assert.equal(await readFile(previousCopyPathIn(room.dataHome, 1), "utf8"), PAGE_WITHOUT_EPICS);
  assert.deepEqual((await readJournal(room.dataHome)).at(-1), {
    at: WRITTEN_AT.toISOString(),
    writer: "where-i-stand",
    action: JournalAction.Edit,
    version: versionOf(PAGE_WITH_EPICS),
    added: [],
    changed: [],
    removed: [],
  });
});

test("a hand edit made before a page gains Epics is still reported as unrecorded", async (t) => {
  const room = await roomWithPage(t, PAGE_WITHOUT_EPICS);
  await editThePageDirectly(room, (content) => content.replace("baking", "burning"));

  await runWhereIStand(["show"], room.dependencies);

  const journal = await readJournal(room.dataHome);
  assert.deepEqual(journal.slice(-2).map((record) => record.writer), ["unknown", "where-i-stand"]);
  assert.deepEqual(journal.at(-2)?.changed, ["ovenqueue"]);
  assert.equal(room.regentNotices.length, 1);
});

test("a page gains no Epics section while another agent holds the edit lock", async (t) => {
  const room = await roomWithPage(t, PAGE_WITHOUT_EPICS);
  const writer = { ...room.dependencies, name: WRITER };
  const held = await takeEditLock(writer, versionOf(PAGE_WITHOUT_EPICS), WRITTEN_AT);
  assert.equal(held.outcome, EditLockOutcome.Taken);

  await runWhereIStand(["show"], room.dependencies);

  assert.equal(await readPageOrEmptyFrame(room), PAGE_WITHOUT_EPICS);
  if (held.outcome === EditLockOutcome.Taken) await releaseEditLock(writer, held);
  await runWhereIStand(["show"], room.dependencies);
  assert.equal(await readPageOrEmptyFrame(room), PAGE_WITH_EPICS);
});

test("a page broken some other way gains no Epics section", async (t) => {
  const broken = PAGE_WITHOUT_EPICS.replace("## Needs you\n", "");
  const room = await roomWithPage(t, broken);

  await runWhereIStand(["show"], room.dependencies);

  assert.equal(await readPageOrEmptyFrame(room), broken);
});

test("a page that has lost its Epics section after gaining it is a broken frame", async (t) => {
  const room = await roomWithPage(t, PAGE_WITH_EPICS);

  const exitCode = await lockEditAndRelease(room, () => PAGE_WITHOUT_EPICS);

  assert.equal(exitCode, WhereIStandExitCode.ReleasedWithFaults);
  assert.match(room.complaints.join(""), /the heading "## Epics" is missing/);
});

test("an epic needs no links line and no objective code", async (t) => {
  const room = await roomWithPage(t, EMPTY_FRAME);

  const exitCode = await lockEditAndRelease(room, () => pageWith({ "## Epics": "\n### Open the second bakery\n" }));

  assert.equal(exitCode, WhereIStandExitCode.Done);
  assert.deepEqual(room.regentNotices, []);
});

test("epics sharing a link are not reported as the same work", async (t) => {
  const room = await roomWithPage(t, EMPTY_FRAME);
  const page = pageWith({
    "## In flight": entry("flourdeal", SAME_LINK),
    "## Epics": `${entry("Buy flour in bulk", SAME_LINK)}${entry("Open the second bakery", SAME_LINK)}`,
  });

  const exitCode = await lockEditAndRelease(room, () => page);

  assert.equal(exitCode, WhereIStandExitCode.Done);
  assert.deepEqual(groupsOfTheSameWork(page), []);
});

test("adding an epic through the page save journals it with the writer Lord", async (t) => {
  const room = await roomWithPage(t, EMPTY_FRAME);

  const exitCode = await saveFromThePage(room, "## Epics", `## Epics\n\n${SECOND_BAKERY}`);

  assert.equal(exitCode, WhereIStandExitCode.Done);
  const page = await readPageOrEmptyFrame(room);
  assert.equal(page, EMPTY_FRAME.replace("## Epics\n", `## Epics\n\n${SECOND_BAKERY}\n`));
  const newest = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([newest?.writer, newest?.version], ["Lord", versionOf(page)]);
  assert.deepEqual(newest?.added, ["Epics: Open the second bakery"]);
});

test("editing an epic through the page save journals it with the writer Lord", async (t) => {
  const room = await roomWithPage(t, pageWith({ "## Epics": `\n${SECOND_BAKERY}\n` }));

  await saveFromThePage(room, SECOND_BAKERY, SECOND_BAKERY.replace("station", "market"));

  const newest = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual([newest?.writer, newest?.changed], ["Lord", ["Epics: Open the second bakery"]]);
});

test("removing an epic leaves its title and notes in the journal", async (t) => {
  const room = await roomWithPage(t, pageWith({ "## In flight": `\n${OVEN_QUEUE}\n`, "## Epics": `\n${SECOND_BAKERY}\n` }));

  assert.equal(await saveFromThePage(room, SECOND_BAKERY, ""), WhereIStandExitCode.Done);
  assert.equal(await lockEditAndRelease(room, (content) => content.replace(`${OVEN_QUEUE}\n`, "")), WhereIStandExitCode.Done);

  const [epicRemoval, entryRemoval] = (await readJournal(room.dataHome)).slice(-2);
  assert.equal(epicRemoval?.writer, "Lord");
  assert.deepEqual(epicRemoval?.removed, ["Epics: Open the second bakery"]);
  assert.deepEqual(epicRemoval?.removedEpics, [
    { title: "Open the second bakery", notes: "Find a site near the station." },
  ]);
  assert.equal(entryRemoval?.removedEpics, undefined);
});
