import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { versionOf } from "./page-frame.ts";
import { JournalAction, readJournal } from "./page-journal.ts";
import { runWhereIStand, WhereIStandExitCode, type WhereIStandDependencies } from "./where-i-stand-runtime.ts";
import {
  entry,
  filesBesideThePage,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  WRITTEN_AT,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const OVEN_QUEUE = "### ovenqueue\n\n- Links: no pull request · ovenqueue · Ticket no ticket\n\nThe oven queue is **baking** with `bake-time` on [the board](https://example.com/board).";
const TILL_REPORT = "### tillreport\n\nThe till report is in flight.";
const SEEDED_PAGE = pageWith({
  "## Just happened": "\n- filed ovenqueue\n- launched tillreport\n- merged breadlabels\n",
  "## In flight": `\n${OVEN_QUEUE}\n\n${TILL_REPORT}\n`,
});

interface SaveAnswer {
  readonly exitCode: number;
  readonly outcome: string;
  readonly message: string;
}

async function seededRoom(t: TestContext): Promise<PageRoom> {
  const room = await pageRoom(t, {
    currentAgentName: async () => {
      throw new Error("the page's save never asks who the caller is");
    },
  });
  await lockEditAndRelease(room, () => SEEDED_PAGE, { currentAgentName: async () => "alpha-bakery-01" });
  room.printed.length = 0;
  return room;
}

async function saveFromThePage(
  room: PageRoom,
  loaded: string,
  edited: string,
  extra: Partial<WhereIStandDependencies> = {},
): Promise<SaveAnswer> {
  const printedBefore = room.printed.length;
  const exitCode = await runWhereIStand(["save"], {
    ...room.dependencies,
    readStandardInput: async () => JSON.stringify({ loaded, edited }),
    ...extra,
  });
  const lines = room.printed.slice(printedBefore).join("").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1);
  const answer = JSON.parse(lines[0] ?? "{}") as { outcome: string; message: string };
  return { exitCode, outcome: answer.outcome, message: answer.message };
}

test("the Lord's save from the page replaces one entry and is journaled with the writer Lord", async (t) => {
  const room = await seededRoom(t);
  const edited = OVEN_QUEUE.replace("is **baking**", "is **out of the oven**");

  const answer = await saveFromThePage(room, OVEN_QUEUE, edited);

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "saved"]);
  const page = await readPageOrEmptyFrame(room);
  assert.equal(page, SEEDED_PAGE.replace(OVEN_QUEUE, edited));
  assert.deepEqual((await readJournal(room.dataHome)).at(-1), {
    at: WRITTEN_AT.toISOString(),
    writer: "Lord",
    action: JournalAction.Edit,
    version: versionOf(page),
    added: [],
    changed: ["ovenqueue"],
    removed: [],
  });
});

test("the Lord's save from the page replaces one Just happened line", async (t) => {
  const room = await seededRoom(t);

  const answer = await saveFromThePage(room, "- launched tillreport", "- launched tillreport on the second oven");

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "saved"]);
  assert.equal(
    await readPageOrEmptyFrame(room),
    SEEDED_PAGE.replace("- launched tillreport\n", "- launched tillreport on the second oven\n"),
  );
  assert.equal((await readJournal(room.dataHome)).at(-1)?.writer, "Lord");
});

test("the Lord can remove a whole entry from the page", async (t) => {
  const room = await seededRoom(t);

  const removedEntry = await saveFromThePage(room, OVEN_QUEUE, "");
  const removedLine = await saveFromThePage(room, "- launched tillreport", "");

  assert.deepEqual([removedEntry.outcome, removedLine.outcome], ["saved", "saved"]);
  assert.equal(
    await readPageOrEmptyFrame(room),
    pageWith({
      "## Just happened": "\n- filed ovenqueue\n- merged breadlabels\n",
      "## In flight": `\n${TILL_REPORT}\n`,
    }),
  );
  const journal = await readJournal(room.dataHome);
  assert.deepEqual(journal.at(-2)?.removed, ["ovenqueue"]);
  assert.deepEqual(journal.slice(-2).map((record) => record.writer), ["Lord", "Lord"]);
});

test("a save whose entry an agent changed since the page loaded is refused and leaves the page unchanged", async (t) => {
  const room = await seededRoom(t);
  await lockEditAndRelease(room, (content) => content.replace("is **baking**", "is **cooling**"), {
    currentAgentName: async () => "alpha-bakery-01",
  });
  const before = await filesBesideThePage(room);

  const answer = await saveFromThePage(room, OVEN_QUEUE, OVEN_QUEUE.replace("is **baking**", "is **sold**"));

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "entry-changed"]);
  assert.match(answer.message, /changed since/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a save is refused and leaves the page unchanged while another holder has the edit lock", async (t) => {
  const room = await seededRoom(t);
  let answer: SaveAnswer | undefined;
  let filesWhileHeld: Record<string, string> = {};
  let filesAfterTheSave: Record<string, string> = {};
  await runWhereIStand(["lock", "--checksum", versionOf(SEEDED_PAGE)], {
    ...room.dependencies,
    currentAgentName: async () => "alpha-florist-01",
    waitForRelease: async () => {
      filesWhileHeld = await filesBesideThePage(room);
      answer = await saveFromThePage(room, OVEN_QUEUE, "");
      filesAfterTheSave = await filesBesideThePage(room);
    },
  });

  assert.deepEqual([answer?.exitCode, answer?.outcome], [WhereIStandExitCode.Refused, "lock-held"]);
  assert.match(answer?.message ?? "", /alpha-florist-01/);
  assert.deepEqual(filesAfterTheSave, filesWhileHeld);
  assert.equal(await readPageOrEmptyFrame(room), SEEDED_PAGE);
});

test("a save that would break the page's frame is refused and leaves the page unchanged", async (t) => {
  const room = await seededRoom(t);
  const before = await filesBesideThePage(room);

  const answer = await saveFromThePage(room, TILL_REPORT, `${TILL_REPORT}\n\n## Needs you`);

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Refused, "frame-broken"]);
  assert.match(answer.message, /## Needs you/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("saving an entry the Lord did not touch changes nothing and journals nothing", async (t) => {
  const room = await seededRoom(t);
  const before = await filesBesideThePage(room);

  const answer = await saveFromThePage(room, OVEN_QUEUE, OVEN_QUEUE);

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "unchanged"]);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("an agent cannot lock or note the page under the name Lord", async (t) => {
  for (const name of ["Lord", "lord", "LORD"]) {
    const room = await seededRoom(t);
    const before = await filesBesideThePage(room);
    const callingAs = { ...room.dependencies, currentAgentName: async () => name };

    const exitCodes = [
      await runWhereIStand(["lock", "--checksum", versionOf(SEEDED_PAGE)], callingAs),
      await runWhereIStand(["note", "launched ovenqueue"], callingAs),
    ];

    assert.deepEqual(exitCodes, [WhereIStandExitCode.Refused, WhereIStandExitCode.Refused]);
    assert.match(room.complaints.join(""), /belongs to the Lord's own saves from the page/);
    assert.deepEqual(await filesBesideThePage(room), before);
  }
});

test("the Lord's save that creates a duplicate is kept and its answer names the duplicate", async (t) => {
  const room = await seededRoom(t);
  const edited = TILL_REPORT.replace("The till report", "- Links: no pull request · ovenqueue · Ticket no ticket\n\nThe till report");
  const ticketed = (text: string): string => text.replaceAll("Ticket no ticket", "Ticket BAKE-12");
  await lockEditAndRelease(room, ticketed, { currentAgentName: async () => "alpha-bakery-01" });
  room.printed.length = 0;

  const answer = await saveFromThePage(room, TILL_REPORT, ticketed(edited));

  assert.deepEqual([answer.exitCode, answer.outcome], [WhereIStandExitCode.Done, "saved"]);
  assert.match(await readPageOrEmptyFrame(room), /### tillreport\n\n- Links: no pull request · ovenqueue · Ticket BAKE-12/);
  assert.match(answer.message, /^Saved; the page now holds your change\. These entries are about the same work: "### ovenqueue" still says .* and "### tillreport" still says "- Links: no pull request · ovenqueue · Ticket BAKE-12"/);
});
