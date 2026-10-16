import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_FRAME, FRAME_HEADINGS, NEWEST_EVENTS_KEPT, versionOf } from "./page-frame.ts";
import { JournalAction, readJournal } from "./page-journal.ts";
import { PAGE_FILE_NAME, pagePathIn, PREVIOUS_COPIES_KEPT, previousCopyPathIn } from "./page-store.ts";
import { realWhereIStandDependencies, runWhereIStand, WhereIStandExitCode } from "./where-i-stand-runtime.ts";
import {
  entry,
  filesBesideThePage,
  lockEditAndRelease,
  pageRoom,
  pageWith,
  readPageOrEmptyFrame,
  temporaryDirectory,
  WRITER,
  WRITTEN_AT,
} from "./where-i-stand.test-support.ts";

function eventsUnderJustHappened(content: string): string[] {
  const [, afterHeading = ""] = content.split(`${FRAME_HEADINGS[0]}\n`);
  const [justHappened = ""] = afterHeading.split(`${FRAME_HEADINGS[1]}\n`);
  return justHappened.split("\n").filter((line) => line.startsWith("- "));
}

test("the page shows its path and its checksum, and no longer a version", async (t) => {
  const room = await pageRoom(t);
  const page = pageWith({ "## In flight": entry("ovenqueue", "The oven queue shows each order's bake time.") });
  await lockEditAndRelease(room, () => page);
  room.printed.length = 0;
  room.complaints.length = 0;

  assert.equal(await runWhereIStand(["show"], room.dependencies), WhereIStandExitCode.Done);

  assert.equal(room.printed.join(""), page);
  assert.equal(room.complaints.join(""), `path: ${pagePathIn(room.dataHome)}\nchecksum: ${versionOf(page)}\n`);
  assert.doesNotMatch(room.complaints.join(""), /version:/);
});

test("showing a page that does not exist yet prints the empty frame and creates nothing", async (t) => {
  const room = await pageRoom(t);

  assert.equal(await runWhereIStand(["show"], room.dependencies), WhereIStandExitCode.Done);

  assert.equal(room.printed.join(""), EMPTY_FRAME);
  assert.deepEqual(room.printed.join("").split("\n").filter((line) => line !== ""), FRAME_HEADINGS);
  assert.match(room.complaints.join(""), new RegExp(`checksum: ${versionOf(EMPTY_FRAME)}\n$`));
  await assert.rejects(readdir(room.dataHome), { code: "ENOENT" });
});

test("write refuses and spells out the whole new flow", async (t) => {
  const invocations = [["write"], ["write", "--based-on", versionOf(EMPTY_FRAME), "--from", "page.md"]];
  for (const invocation of invocations) {
    const room = await pageRoom(t);

    assert.equal(await runWhereIStand(invocation, room.dependencies), WhereIStandExitCode.Refused);

    const message = room.complaints.join("");
    assert.match(message, /refused, nothing was written/);
    assert.match(message, /"throne where-i-stand write" no longer exists/);
    assert.match(message, /1\. Run "throne where-i-stand show"\. It prints the page on stdout, and its path and checksum on stderr\. Read the page with your own file tool at that path\./);
    assert.match(message, /2\. Run "throne where-i-stand lock --checksum <checksum> --ttl 5m" in the background/);
    assert.match(message, /3\. While the lock is held, change your own entry with your harness's edit tool: a targeted replacement of that entry's text, one entry at a time\. Never rewrite the whole file\./);
    assert.match(message, /4\. Stop the background lock command to release the lock, and read its output/);
    assert.match(message, /throne where-i-stand note/);
    await assert.rejects(readdir(room.dataHome), { code: "ENOENT" });
  }
});

test("each edit keeps the page before it as a previous copy and only a few copies are kept", async (t) => {
  const room = await pageRoom(t);
  const pages = Array.from({ length: PREVIOUS_COPIES_KEPT + 3 }, (_, index) =>
    pageWith({ "## In flight": entry("ovenqueue", `Tray ${index + 1} is in.`) }),
  );

  for (const page of pages) assert.equal(await lockEditAndRelease(room, () => page), WhereIStandExitCode.Done);

  const newestFirst = [...pages].reverse();
  for (let editsAgo = 1; editsAgo <= PREVIOUS_COPIES_KEPT; editsAgo += 1) {
    assert.equal(await readFile(previousCopyPathIn(room.dataHome, editsAgo), "utf8"), newestFirst[editsAgo]);
  }
  const copies = (await readdir(room.dataHome)).filter((name) => name.includes(".previous-"));
  assert.equal(copies.length, PREVIOUS_COPIES_KEPT);
});

test("a note goes to the top of Just happened and only the newest fifteen are kept", async (t) => {
  const room = await pageRoom(t);
  const pageBeforeTheNotes = pageWith({ "## In flight": entry("ovenqueue", "Baking.") });
  await lockEditAndRelease(room, () => pageBeforeTheNotes);
  const notesWritten = NEWEST_EVENTS_KEPT + 2;

  for (let number = 1; number <= notesWritten; number += 1) {
    assert.equal(await runWhereIStand(["note", `event ${number}`], room.dependencies), WhereIStandExitCode.Done);
  }

  const page = await readPageOrEmptyFrame(room);
  const events = eventsUnderJustHappened(page);
  assert.equal(NEWEST_EVENTS_KEPT, 15);
  assert.equal(events.length, NEWEST_EVENTS_KEPT);
  assert.equal(events[0], `- event ${notesWritten}`);
  assert.equal(events.at(-1), "- event 3");
  assert.equal(
    page.slice(page.indexOf("## Needs you")),
    pageBeforeTheNotes.slice(pageBeforeTheNotes.indexOf("## Needs you")),
  );
  assert.equal(page.startsWith(`## Just happened\n\n- event ${notesWritten}\n- event ${notesWritten - 1}\n`), true);
});

test("a note is journaled with who wrote it and when, and changes no entry", async (t) => {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => pageWith({ "## In flight": entry("ovenqueue", "Baking.") }));

  assert.equal(await runWhereIStand(["note", "launched ovenqueue"], room.dependencies), WhereIStandExitCode.Done);

  assert.deepEqual((await readJournal(room.dataHome)).at(-1), {
    at: WRITTEN_AT.toISOString(),
    writer: WRITER,
    action: JournalAction.Note,
    version: versionOf(await readPageOrEmptyFrame(room)),
    added: [],
    changed: [],
    removed: [],
  });
});

test("a note on a page whose frame is broken is refused and leaves the page as it is", async (t) => {
  const room = await pageRoom(t);
  await lockEditAndRelease(room, () => EMPTY_FRAME.replace("## Needs you\n", ""));
  const before = await filesBesideThePage(room);

  assert.equal(await runWhereIStand(["note", "launched ovenqueue"], room.dependencies), WhereIStandExitCode.Refused);

  assert.match(room.complaints.join(""), /the heading "## Needs you" is missing/);
  assert.deepEqual(await filesBesideThePage(room), before);
});

test("a caller with no agent identity cannot lock or write the page", async (t) => {
  const room = await pageRoom(t, {
    currentAgentName: async () => {
      throw new Error('current herdr pane "w1:p1" resolves to 0 live agents');
    },
  });

  const exitCodes = [
    await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], room.dependencies),
    await runWhereIStand(["note", "launched ovenqueue"], room.dependencies),
  ];

  assert.deepEqual(exitCodes, [WhereIStandExitCode.Refused, WhereIStandExitCode.Refused]);
  assert.match(room.complaints.join(""), /Only a caller with an agent identity may lock or write the page/);
  assert.match(room.complaints.join(""), /resolves to 0 live agents/);
  assert.match(room.complaints.join(""), /No bypass is available for this refusal/);
  assert.match(room.complaints.join(""), /ask your supervisor to make the edit/);
  await assert.rejects(readdir(room.dataHome), { code: "ENOENT" });
  assert.equal(await runWhereIStand(["show"], room.dependencies), WhereIStandExitCode.Done);
});

test("the page lives under the data home the code resolves", async (t) => {
  const resolvedDataHome = path.join(await temporaryDirectory(t), "resolved-home");
  const room = await pageRoom(t, {
    dataHome: realWhereIStandDependencies({ THRONE_DATA_HOME: resolvedDataHome }).dataHome,
  });

  assert.equal(await runWhereIStand(["note", "filed ovenqueue"], room.dependencies), WhereIStandExitCode.Done);

  assert.equal(room.dependencies.dataHome, resolvedDataHome);
  assert.deepEqual(eventsUnderJustHappened(await readFile(path.join(resolvedDataHome, PAGE_FILE_NAME), "utf8")), [
    "- filed ovenqueue",
  ]);
  assert.deepEqual((await readJournal(resolvedDataHome)).map((record) => record.action), [JournalAction.Note]);
});

test("a note or a lock on a machine without flock fails naming flock and how to install it", async (t) => {
  const room = await pageRoom(t, { flockExecutable: "flock-that-is-not-installed" });

  const exitCodes = [
    await runWhereIStand(["note", "filed ovenqueue"], room.dependencies),
    await runWhereIStand(["lock", "--checksum", versionOf(EMPTY_FRAME)], room.dependencies),
  ];

  assert.deepEqual(exitCodes, [WhereIStandExitCode.Refused, WhereIStandExitCode.Refused]);
  assert.match(room.complaints.join(""), /flock-that-is-not-installed is not installed/);
  assert.match(room.complaints.join(""), /where-i-stand edit lock cannot be taken/);
  assert.match(room.complaints.join(""), /brew install flock/);
  await assert.rejects(readFile(pagePathIn(room.dataHome)), { code: "ENOENT" });
});

test("where-i-stand refuses an unknown action, an unknown flag or a missing argument before touching the page", async (t) => {
  const malformedInvocations: readonly (readonly string[])[] = [
    [],
    ["erase"],
    ["unlock"],
    ["show", "--everything"],
    ["show", "--checksum", versionOf(EMPTY_FRAME)],
    ["lock"],
    ["lock", "--checksum", ""],
    ["lock", "--checksum", versionOf(EMPTY_FRAME), "--ttl", "0m"],
    ["lock", "--checksum", versionOf(EMPTY_FRAME), "--ttl", "five minutes"],
    ["lock", "--checksum", versionOf(EMPTY_FRAME), "extra"],
    ["note"],
    ["note", "two", "arguments"],
    ["note", "first line\nsecond line"],
    ["note", "launched", "--ttl", "5m"],
  ];
  for (const invocation of malformedInvocations) {
    let identityLookups = 0;
    const room = await pageRoom(t, {
      currentAgentName: async () => {
        identityLookups += 1;
        return WRITER;
      },
    });

    assert.equal(await runWhereIStand(invocation, room.dependencies), WhereIStandExitCode.InvalidInvocation);

    assert.match(room.complaints.join(""), /usage: throne where-i-stand show/);
    assert.match(room.complaints.join(""), /where-i-stand entrance validation refused this invocation/);
    assert.match(room.complaints.join(""), /No bypass is available for this refusal/);
    assert.equal(identityLookups, 0);
    await assert.rejects(readdir(room.dataHome), { code: "ENOENT" });
  }
});
