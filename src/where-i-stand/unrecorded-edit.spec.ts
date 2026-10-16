import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { versionOf } from "./page-frame.ts";
import { journalPathIn, JournalAction, readJournal, UNRECORDED_WRITER } from "./page-journal.ts";
import { pagePathIn } from "./page-store.ts";
import { runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import {
  editThePageDirectly,
  entry,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  WRITTEN_AT,
  type PageRoom,
} from "./where-i-stand.test-support.ts";

const JOURNALED = pageWith({ "## In flight": entry("ovenqueue", "Baking.") + entry("tillreport", "Counting.") });
const CHANGED_WITH_NO_LOCK = pageWith({ "## In flight": entry("ovenqueue", "Baked.") });

const COMMANDS_THAT_CATCH_AN_UNRECORDED_EDIT: Record<string, (room: PageRoom) => Promise<number>> = {
  show: (room) => runWhereIStand(["show"], room.dependencies),
  note: (room) => runWhereIStand(["note", "launched breadlabels"], room.dependencies),
  lock: (room) => runWhereIStand(["lock", "--checksum", versionOf(CHANGED_WITH_NO_LOCK)], room.dependencies),
};

for (const [command, run] of Object.entries(COMMANDS_THAT_CATCH_AN_UNRECORDED_EDIT)) {
  test(`an edit made without a lock is caught by the next ${command}, journaled as unknown, and the Regent is told`, async (t) => {
    const room = await pageRoom(t);
    await lockEditAndRelease(room, () => JOURNALED);
    await editThePageDirectly(room, () => CHANGED_WITH_NO_LOCK);

    assert.equal(await run(room), WhereIStandExitCode.Done);

    const unrecorded = (await readJournal(room.dataHome)).find((record) => record.writer === UNRECORDED_WRITER);
    assert.deepEqual(unrecorded, {
      at: WRITTEN_AT.toISOString(),
      writer: UNRECORDED_WRITER,
      action: JournalAction.UnrecordedEdit,
      version: versionOf(CHANGED_WITH_NO_LOCK),
      added: [],
      changed: ["ovenqueue"],
      removed: ["tillreport"],
    });
    assert.equal(room.regentNotices.length, 1);
    assert.match(room.regentNotices[0] ?? "", new RegExp(`${pagePathIn(room.dataHome)} was changed with no lock held`));
    assert.match(room.regentNotices[0] ?? "", /added none; changed ovenqueue; removed tillreport/);
  });
}

test("an unrecorded edit is journaled once, so the next show finds the page as the journal left it", async (t) => {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => JOURNALED);
  await editThePageDirectly(room, () => CHANGED_WITH_NO_LOCK);

  await runWhereIStand(["show"], room.dependencies);
  await runWhereIStand(["show"], room.dependencies);

  const unrecorded = (await readJournal(room.dataHome)).filter((record) => record.writer === UNRECORDED_WRITER);
  assert.equal(unrecorded.length, 1);
  assert.equal(room.regentNotices.length, 1);
});

test("an unrecorded edit with no kept copy of the journaled page is still journaled and the Regent is told the changes could not be listed", async (t) => {
  const room = await pageRoom(t);
  await mkdir(room.dataHome, { recursive: true });
  await writeFile(
    journalPathIn(room.dataHome),
    `${JSON.stringify({ at: WRITTEN_AT.toISOString(), writer: "alpha-bakery-01", action: JournalAction.Write, version: versionOf(JOURNALED), added: [], changed: [], removed: [] })}\n`,
  );
  await writeFile(pagePathIn(room.dataHome), CHANGED_WITH_NO_LOCK);

  await runWhereIStand(["show"], room.dependencies);

  const unrecorded = (await readJournal(room.dataHome)).at(-1);
  assert.deepEqual(
    [unrecorded?.writer, unrecorded?.version, unrecorded?.added, unrecorded?.changed, unrecorded?.removed],
    [UNRECORDED_WRITER, versionOf(CHANGED_WITH_NO_LOCK), [], [], []],
  );
  assert.match(room.regentNotices[0] ?? "", /no copy of the page as last journaled was kept/);
  assert.equal(await readPageOrEmptyFrame(room), CHANGED_WITH_NO_LOCK);
});

const REFUSALS_AFTER_AN_UNRECORDED_EDIT_IS_JOURNALED: Record<string, { change: string; run: (room: PageRoom) => Promise<number> }> = {
  "a lock based on an older page": {
    change: CHANGED_WITH_NO_LOCK,
    run: (room) => runWhereIStand(["lock", "--checksum", versionOf(JOURNALED)], room.dependencies),
  },
  "a note on a page whose frame is broken": {
    change: CHANGED_WITH_NO_LOCK.replace("## Needs you\n", ""),
    run: (room) => runWhereIStand(["note", "launched breadlabels"], room.dependencies),
  },
};

for (const [refusal, { change, run }] of Object.entries(REFUSALS_AFTER_AN_UNRECORDED_EDIT_IS_JOURNALED)) {
  test(`${refusal} that first journals an unrecorded edit says the journal was written, not that nothing was`, async (t) => {
    const room = await pageRoom(t);
    await lockEditAndRelease(room, () => JOURNALED);
    await editThePageDirectly(room, () => change);

    assert.equal(await run(room), WhereIStandExitCode.Refused);

    assert.equal((await readJournal(room.dataHome)).at(-1)?.writer, UNRECORDED_WRITER);
    assert.doesNotMatch(room.complaints.join(""), /nothing was written/);
    assert.match(room.complaints.join(""), /refused; only the unrecorded edit above was journaled, and the page was not changed\./);
    assert.equal(await readPageOrEmptyFrame(room), change);
  });
}
