import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { readTable } from "../where-i-stand-store/where-i-stand-store.test-support.ts";
import { commandRoom, entryText, STARTED_AT, WRITER, type CommandRoom } from "./where-i-stand.test-support.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function putInFlight(room: CommandRoom, code: string, whereItStands = "building"): Promise<string> {
  const ran = await room.run(["put", "--local", "--code", code, "--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken(), "--text", entryText(whereItStands)]);
  assert.equal(ran.exitCode, 0, ran.complaints);
  return /(r\d+)/.exec(ran.printed)![1];
}

function contentRows(room: CommandRoom): Record<string, unknown>[] {
  return readTable(room.home, "content");
}

test("B1.1 put --remove archives the live work entry, keeping it in the database with the time and the writer", async (t) => {
  const room = await commandRoom(t);
  const rowId = await putInFlight(room, "alpha-oven");
  room.clock.time = new Date(STARTED_AT.getTime() + DAY_MS);

  const removed = await room.run(["put", "--local", "--code", "alpha-oven", "--remove"]);

  assert.equal(removed.exitCode, 0, removed.complaints);
  assert.match(removed.printed, new RegExp(`Archived ${rowId}`));
  assert.doesNotMatch((await room.run(["show", "--local"])).printed, /alpha-oven/);
  const [row] = contentRows(room).filter((each) => each.code === "alpha-oven");
  assert.equal(row.archived_at, STARTED_AT.getTime() + DAY_MS);
  assert.equal(row.archived_by, WRITER);
});

test("B1.1 put --remove on a code with no live entry is refused and writes nothing", async (t) => {
  const room = await commandRoom(t);
  const ran = await room.run(["put", "--local", "--code", "alpha-nothing", "--remove"]);
  assert.equal(ran.exitCode, 1);
  assert.match(ran.complaints, /No live work entry holds alpha-nothing/);
});

test("B1.3 restore from the command brings the row back among the live rows with its text unchanged", async (t) => {
  const room = await commandRoom(t);
  const rowId = await putInFlight(room, "alpha-oven", "the door is fitted");
  await room.run(["archive", "--local", rowId]);

  const restored = await room.run(["restore", "--local", rowId]);

  assert.equal(restored.exitCode, 0, restored.complaints);
  assert.match((await room.run(["show", "--local"])).printed, /### alpha-oven\n- Links: no pull request · branch oven · Ticket no ticket\n- Kind: bug fix — keep the oven warm\n- Where it stands: the door is fitted/);
});

test("B1.9 archiving and restoring rows and sections through the commands never deletes a row", async (t) => {
  const room = await commandRoom(t);
  const rowId = await putInFlight(room, "alpha-oven");
  const sectionId = await room.sectionId("In flight");
  for (const command of [["archive", rowId], ["restore", rowId], ["archive", sectionId], ["restore", sectionId], ["put", "--code", "alpha-oven", "--remove"]]) {
    assert.equal((await room.run([...command, "--local"])).exitCode, 0);
  }
  assert.equal(contentRows(room).length, 1);
  assert.equal(readTable(room.home, "journal").filter((entry) => entry.action === "delete").length, 0);
});

test("B2.2 purge --dry-run lists exactly the rows the sweep would delete and deletes none", async (t) => {
  const room = await commandRoom(t);
  const expired = await putInFlight(room, "alpha-expired");
  const recent = await putInFlight(room, "alpha-recent");
  await room.run(["archive", "--local", expired]);
  room.clock.time = new Date(STARTED_AT.getTime() + 60 * DAY_MS);
  await room.run(["archive", "--local", recent]);
  room.clock.time = new Date(STARTED_AT.getTime() + 190 * DAY_MS);

  const dryRun = await room.run(["purge", "--local", "--dry-run"]);

  assert.equal(dryRun.exitCode, 0, dryRun.complaints);
  assert.match(dryRun.printed, /would delete 1 archived item/);
  assert.match(dryRun.printed, new RegExp(`${expired} alpha-expired`));
  assert.doesNotMatch(dryRun.printed, /alpha-recent/);
  assert.equal(contentRows(room).length, 2);
  const swept = await room.run(["purge", "--local"]);
  assert.match(swept.printed, /deleted 1 archived item/);
  assert.deepEqual(contentRows(room).map((row) => row.code), ["alpha-recent"]);
});

test("B3.2 a tab and a section created by command are in the listing and on the page", async (t) => {
  const room = await commandRoom(t);
  const tab = await room.run(["add-tab", "--local", "--name", "Bakery", "--listing-token", await room.listingToken()]);
  assert.equal(tab.exitCode, 0, tab.complaints);
  const tabId = /(t\d+)/.exec(tab.printed)![1];
  const section = await room.run(["add-section", "--local", "--tab-id", tabId, "--name", "Ovens", "--listing-token", await room.listingToken()]);
  assert.equal(section.exitCode, 0, section.complaints);

  assert.match((await room.run(["list", "--local"])).printed, new RegExp(`${tabId} "Bakery".*\\n  s\\d+ "Ovens"`));
  assert.match((await room.run(["show", "--local"])).printed, /# Bakery \(t\d+\)\n\n## Ovens \(s\d+\)/);
});

test("B3.3 a subsection created under a section is listed under it and holds rows", async (t) => {
  const room = await commandRoom(t);
  const parentId = await room.sectionId("In flight");
  const tabLine = /(t\d+) "Now"/.exec((await room.run(["list", "--local"])).printed)!;
  const created = await room.run(["add-section", "--local", "--tab-id", tabLine[1], "--parent-id", parentId, "--name", "Oven work", "--listing-token", await room.listingToken()]);
  assert.equal(created.exitCode, 0, created.complaints);
  const subsectionId = await room.sectionId("Oven work");

  const put = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", subsectionId, "--listing-token", await room.listingToken(), "--text", entryText()]);

  assert.equal(put.exitCode, 0, put.complaints);
  assert.match((await room.run(["list", "--local"])).printed, new RegExp(`  ${parentId} "In flight".*\\n    ${subsectionId} "Oven work"`));
  assert.match((await room.run(["show", "--local"])).printed, /## In flight › Oven work \(s\d+\)\n\n### alpha-oven/);
});

test("B3.4 a work entry without its links, kind or where-it-stands line is refused naming the missing one", async (t) => {
  const room = await commandRoom(t);
  const cases: readonly (readonly [string, RegExp])[] = [
    ["- Kind: bug fix\n- Where it stands: building", /needs links/],
    ["- Links: no pull request · branch oven · Ticket no ticket\n- Where it stands: building", /needs kind/],
    ["- Links: no pull request · branch oven · Ticket no ticket\n- Kind: bug fix", /needs where it stands/],
  ];
  for (const [text, missing] of cases) {
    const ran = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken(), "--text", text]);
    assert.equal(ran.exitCode, 1);
    assert.match(ran.complaints, missing);
  }
  assert.equal(contentRows(room).length, 0);
});

test("B3.5 put on a code that already has a live row replaces it, even from another section", async (t) => {
  const room = await commandRoom(t);
  const rowId = await putInFlight(room, "alpha-oven", "building");
  const moved = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", await room.sectionId("Delivered, not on GitHub"), "--listing-token", await room.listingToken(), "--text", entryText("merged")]);
  assert.equal(moved.exitCode, 0, moved.complaints);
  assert.match(moved.printed, new RegExp(`Replaced the live row ${rowId}`));
  const live = contentRows(room).filter((row) => row.code === "alpha-oven" && row.archived_at === null);
  assert.equal(live.length, 1);
  assert.equal(live[0].where_it_stands, "merged");
});

test("B4.1 list prints every tab and section with its id, archived ones marked, and a listing token", async (t) => {
  const room = await commandRoom(t);
  await room.run(["archive", "--local", await room.sectionId("Queued and deferred")]);
  const listed = await room.run(["list", "--local"]);
  assert.equal(listed.exitCode, 0);
  assert.match(listed.printed, /^listing token: [0-9a-f]{12}\n/);
  for (const name of ["Now", "Epics", "Queue", "Delivered", "Pull requests"]) assert.match(listed.printed, new RegExp(`^t\\d+ "${name}"`, "m"));
  for (const name of ["Needs you", "Just happened", "In flight", "Epics", "Delivered, not on GitHub", "On GitHub"]) {
    assert.match(listed.printed, new RegExp(`^  s\\d+ "${name}" \\(written`, "m"));
  }
  assert.match(listed.printed, /^  s\d+ "Queued and deferred" \[archived\] \(/m);
});

test("B4.2 adding a row with a section name instead of an id is refused", async (t) => {
  const room = await commandRoom(t);
  const byNameAsId = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", "In flight", "--listing-token", await room.listingToken(), "--text", entryText()]);
  assert.equal(byNameAsId.exitCode, 1);
  assert.match(byNameAsId.complaints, /"In flight" is not a section id/);
  for (const name of ["Needs you", "In flight", "Queued and deferred", "Delivered, not on GitHub", "On GitHub", "Epics"]) {
    const byName = await room.run(["put", "--local", "--code", "alpha-oven", "--section", name, "--text", entryText()]);
    assert.equal(byName.exitCode, 1, name);
    assert.match(byName.complaints, new RegExp(`put does not find a section by name, and "${name}" is a name`));
  }
  assert.equal(contentRows(room).length, 0);
});

test("B4.3 adding a row with a token from before the structure last changed is refused and prints the current listing", async (t) => {
  const room = await commandRoom(t);
  const oldToken = await room.listingToken();
  await room.run(["archive", "--local", await room.sectionId("On GitHub")]);
  const ran = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", await room.sectionId("In flight"), "--listing-token", oldToken, "--text", entryText()]);
  assert.equal(ran.exitCode, 1);
  assert.match(ran.complaints, /listing token is out of date/);
  assert.match(ran.complaints, new RegExp(`listing token: ${await room.listingToken()}\\n`));
  assert.equal(contentRows(room).length, 0);
});

test("B4.4 creating a section whose name matches a live sibling, ignoring case and spaces, is refused naming it", async (t) => {
  const room = await commandRoom(t);
  const tabId = /(t\d+) "Now"/.exec((await room.run(["list", "--local"])).printed)![1];
  const ran = await room.run(["add-section", "--local", "--tab-id", tabId, "--name", "  in FLIGHT ", "--listing-token", await room.listingToken()]);
  assert.equal(ran.exitCode, 1);
  assert.match(ran.complaints, new RegExp(`"In flight" already exists here as ${await room.sectionId("In flight")}`));
});

test("B4.5 creating a section whose name matches an archived sibling revives it and says so", async (t) => {
  const room = await commandRoom(t);
  const sectionId = await room.sectionId("In flight");
  const tabId = /(t\d+) "Now"/.exec((await room.run(["list", "--local"])).printed)![1];
  await room.run(["archive", "--local", sectionId]);
  const ran = await room.run(["add-section", "--local", "--tab-id", tabId, "--name", "In flight", "--listing-token", await room.listingToken()]);
  assert.equal(ran.exitCode, 0, ran.complaints);
  assert.match(ran.printed, new RegExp(`archived section "In flight" \\(${sectionId}\\) is revived`));
  assert.equal(readTable(room.home, "section").filter((section) => section.name === "In flight").length, 1);
});

test("B4.6 adding a row to an archived section revives the section and leaves its archived rows archived", async (t) => {
  const room = await commandRoom(t);
  const oldRow = await putInFlight(room, "alpha-old");
  await room.run(["archive", "--local", oldRow]);
  const sectionId = await room.sectionId("In flight");
  await room.run(["archive", "--local", sectionId]);
  const ran = await room.run(["put", "--local", "--code", "alpha-new", "--section-id", sectionId, "--listing-token", await room.listingToken(), "--text", entryText()]);
  assert.equal(ran.exitCode, 0, ran.complaints);
  assert.match(ran.printed, new RegExp(`Section ${sectionId} "In flight" was archived and is revived`));
  assert.notEqual(contentRows(room).find((row) => row.code === "alpha-old")!.archived_at, null);
});

test("B5.8 show and list print exact dates", async (t) => {
  const room = await commandRoom(t);
  await putInFlight(room, "alpha-oven");
  room.clock.time = new Date("2026-06-17T08:45:00.000Z");
  await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken(), "--text", entryText("testing")]);
  await room.run(["note", "--local", "the oven is warm"]);
  const shown = (await room.run(["show", "--local"])).printed;
  assert.match(shown, /- r\d+: written 2026-06-15 12:00 UTC by alpha-bakery-01, changed 2026-06-17 08:45 UTC by alpha-bakery-01/);
  assert.match(shown, /- the oven is warm \(2026-06-17 08:45 UTC, r\d+\)/);
  assert.match((await room.run(["list", "--local"])).printed, /"In flight" \(written 2026-06-15 12:00 UTC by alpha-bakery-01\)/);
});

test("B5.9 no command takes a date: a write records the database's time", async (t) => {
  const room = await commandRoom(t);
  const dated = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken(), "--written-at", "2020-01-01", "--text", entryText()]);
  assert.equal(dated.exitCode, 2);
  room.clock.time = new Date("2026-06-20T10:00:00.000Z");
  await putInFlight(room, "alpha-oven");
  assert.equal(contentRows(room)[0].written_at, Date.parse("2026-06-20T10:00:00.000Z"));
});

test("B7.7 note adds an event line to Just happened and show prints the page as Markdown", async (t) => {
  const room = await commandRoom(t);
  const noted = await room.run(["note", "--local", "launched the bakery page"]);
  assert.equal(noted.exitCode, 0, noted.complaints);
  await putInFlight(room, "alpha-oven");
  const shown = await room.run(["show", "--local"]);
  assert.equal(shown.exitCode, 0);
  assert.match(shown.printed, /^# Now \(t\d+\)\n\n## Needs you \(s\d+\)\n\n## Just happened \(s\d+\)\n\n- launched the bakery page \(2026-06-15 12:00 UTC, r\d+\)\n\n## In flight \(s\d+\)\n\n### alpha-oven\n/);
});

test("today's put invocation with a text file and a body starting with a dash still writes the entry", async (t) => {
  const room = await commandRoom(t);
  const file = path.join(room.home, "entry.md");
  await writeFile(file, `\n${entryText()}Written by alpha-bakery-01.\n`);
  const ran = await room.run(["put", "--local", "--code", "alpha-oven", "--section-id", await room.sectionId("In flight"), "--listing-token", await room.listingToken(), "--text-file", file]);
  assert.equal(ran.exitCode, 0, ran.complaints);
  assert.match((await room.run(["show", "--local"])).printed, /- Where it stands: building\nWritten by alpha-bakery-01\.\n/);
});

test("a caller writing under the Lord's name is refused before anything is written", async (t) => {
  const room = await commandRoom(t);
  assert.match((await room.run(["note", "--local", "hello"], "Lord")).complaints, /belongs to the Lord/);
  assert.equal(contentRows(room).length, 0);
});

test("an unknown action, a stray flag or the retired lock and save actions are refused with the usage", async (t) => {
  const room = await commandRoom(t);
  for (const invocation of [["lock", "--checksum", "abc"], ["save"], ["write"], ["show", "--code", "x"], []]) {
    const ran = await room.run(invocation);
    assert.equal(ran.exitCode, 2, invocation.join(" "));
    assert.match(ran.complaints, /usage: throne where-i-stand list/);
  }
});
