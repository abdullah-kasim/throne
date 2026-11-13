import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  addEventLines,
  addRow,
  createSection,
  createTab,
  DAY_MS,
  readTable,
  scratchStore,
  token,
  workEntry,
  WRITER,
  type ScratchStore,
} from "./where-i-stand-store.test-support.ts";

let scratch: ScratchStore;
let tabId: string;
let sectionId: string;

beforeEach(async () => {
  scratch = await scratchStore();
  tabId = await createTab(scratch.store, "Now");
  sectionId = await createSection(scratch.store, tabId, "In flight");
});

afterEach(async () => {
  await scratch.close();
});

async function liveCodes(): Promise<(string | null)[]> {
  return (await scratch.store.page()).rows.map((row) => row.code);
}

async function codesIn(section: string): Promise<(string | null)[]> {
  return (await scratch.store.page()).rows.filter((row) => row.sectionId === section).map((row) => row.code);
}

test("a row added with a listing token from before the structure changed is refused and the current listing is printed", async () => {
  const oldToken = await token(scratch.store);
  await createSection(scratch.store, tabId, "Needs you");
  const answer = await scratch.store.addRow({ sectionId, listingToken: oldToken, writer: WRITER, row: workEntry("alpha-oven") });
  assert.equal(answer.outcome, "refused");
  assert.match(answer.message, /listing token is out of date/);
  assert.deepEqual(answer.listing?.sections.map((section) => section.name), ["In flight", "Needs you"]);
  assert.deepEqual(readTable(scratch.home, "content"), []);
});

test("adding a row with a section name instead of an id is refused", async () => {
  const answer = await scratch.store.addRow({ sectionId: "In flight", listingToken: await token(scratch.store), writer: WRITER, row: workEntry("alpha-oven") });
  assert.equal(answer.outcome, "refused");
  assert.match(answer.message, /not a section id/);
  assert.deepEqual(readTable(scratch.home, "content"), []);
});

test("a work entry missing its kind is refused naming the missing field and nothing is written", async () => {
  const answer = await scratch.store.addRow({ sectionId, listingToken: await token(scratch.store), writer: WRITER, row: { ...workEntry("alpha-oven"), workKind: " " } });
  assert.equal(answer.outcome, "refused");
  assert.match(answer.message, /needs kind/);
  assert.deepEqual(readTable(scratch.home, "content"), []);
});

test("a work entry for a code that already has a live row replaces it and there is never a second live row", async () => {
  const queue = await createSection(scratch.store, tabId, "Queued and deferred");
  const first = await addRow(scratch.store, queue, workEntry("alpha-oven", "queued"));
  scratch.clock.advance(DAY_MS);
  const second = await addRow(scratch.store, sectionId, workEntry("alpha-oven", "building"));
  assert.equal(second.id, first.id);
  assert.equal(second.sectionId, sectionId);
  assert.equal(second.whereItStands, "building");
  assert.equal(second.writtenAt, first.writtenAt);
  assert.notEqual(second.changedAt, first.changedAt);
  assert.deepEqual(await liveCodes(), ["alpha-oven"]);
});

test("adding to an archived section revives the section and says so while its archived rows stay archived", async () => {
  const archived = await addRow(scratch.store, sectionId, workEntry("alpha-flour"));
  await scratch.store.archiveSection(sectionId, { writer: WRITER });
  const answer = await scratch.store.addRow({ sectionId, listingToken: await token(scratch.store), writer: WRITER, row: workEntry("alpha-oven") });
  assert.equal(answer.outcome, "done");
  assert.match(answer.message, /was archived and is revived/);
  assert.deepEqual(await liveCodes(), ["alpha-oven"]);
  assert.deepEqual((await scratch.store.archivedRows(sectionId)).rows.map((row) => row.id), [archived.id]);
});

test("a section whose name matches a live sibling ignoring case and spaces is refused naming the existing one", async () => {
  const answer = await scratch.store.createSection({ tabId, name: "  in FLIGHT ", listingToken: await token(scratch.store), writer: WRITER });
  assert.equal(answer.outcome, "refused");
  assert.match(answer.message, new RegExp(`"In flight" already exists here as ${sectionId}`));
});

test("a section whose name matches an archived sibling is revived instead and no second section exists", async () => {
  await scratch.store.archiveSection(sectionId, { writer: WRITER });
  const answer = await scratch.store.createSection({ tabId, name: "in flight", listingToken: await token(scratch.store), writer: WRITER });
  assert.equal(answer.outcome, "done");
  assert.match(answer.message, /is revived instead of a second one/);
  assert.equal(answer.section?.id, sectionId);
  assert.equal(readTable(scratch.home, "section").length, 1);
});

test("a subsection created under an archived section revives that section so the purge never deletes the live subsection", async () => {
  await scratch.store.archiveSection(sectionId, { writer: WRITER });
  const answer = await scratch.store.createSection({ tabId, parentId: sectionId, name: "Oven work", listingToken: await token(scratch.store), writer: WRITER });
  assert.match(answer.message, /Section s1 "In flight" was archived and is revived/);
  scratch.clock.advance(200 * DAY_MS);
  await scratch.store.purge({ dryRun: false, writer: WRITER });
  const listing = await scratch.store.listing();
  assert.deepEqual(listing.sections.map((section) => [section.name, section.archivedAt]), [["In flight", null], ["Oven work", null]]);
});

test("a subsection is created under its parent and holds rows", async () => {
  const subsection = await createSection(scratch.store, tabId, "Oven work", sectionId);
  const row = await addRow(scratch.store, subsection, workEntry("alpha-oven"));
  const listing = await scratch.store.listing();
  assert.equal(listing.sections.find((section) => section.id === subsection)?.parentId, sectionId);
  assert.equal(row.sectionId, subsection);
});

test("an archived row leaves the live rows but stays in the database with its time and writer and restore brings it back unchanged", async () => {
  const row = await addRow(scratch.store, sectionId, { ...workEntry("alpha-oven"), freeLines: ["a free line"] });
  scratch.clock.advance(60_000);
  await scratch.store.archiveRow(row.id, { writer: "the Lord" });
  assert.deepEqual(await liveCodes(), []);
  const stored = readTable(scratch.home, "content")[0]!;
  assert.equal(stored.archived_by, "the Lord");
  assert.equal(stored.archived_at, scratch.clock.time.getTime());
  await scratch.store.restoreRow(row.id, { writer: WRITER });
  const restored = (await scratch.store.page()).rows[0]!;
  assert.deepEqual({ ...restored, changedAt: row.changedAt }, row);
});

test("archiving a section takes its live rows and restoring it brings back only the rows that were live", async () => {
  const earlier = await addRow(scratch.store, sectionId, workEntry("alpha-flour"));
  await scratch.store.archiveRow(earlier.id, { writer: WRITER });
  scratch.clock.advance(60_000);
  await addRow(scratch.store, sectionId, workEntry("alpha-oven"));
  scratch.clock.advance(60_000);
  await scratch.store.archiveSection(sectionId, { writer: WRITER });
  assert.deepEqual(await liveCodes(), []);
  scratch.clock.advance(60_000);
  await scratch.store.restoreSection(sectionId, { writer: WRITER });
  assert.deepEqual(await liveCodes(), ["alpha-oven"]);
  assert.deepEqual((await scratch.store.archivedRows(sectionId)).rows.map((row) => row.code), ["alpha-flour"]);
});

test("the sixteenth event line archives the oldest and fifteen stay live", async () => {
  await addEventLines(scratch, sectionId, 16);
  const live = (await scratch.store.page()).rows.map((row) => row.text);
  assert.equal(live.length, 15);
  assert.ok(!live.includes("event 1"));
  assert.deepEqual((await scratch.store.archivedRows(sectionId)).rows.map((row) => row.text), ["event 1"]);
});

test("Delivered keeps its newest twenty rows and every row younger than three days and archives the rest on a write", async () => {
  const delivered = await createSection(scratch.store, await createTab(scratch.store, "Delivered"), "Delivered, not on GitHub");
  for (let entry = 1; entry <= 22; entry++) {
    await addRow(scratch.store, delivered, workEntry(`alpha-old-${entry}`));
    scratch.clock.advance(60_000);
  }
  assert.equal((await scratch.store.page()).rows.length, 22);
  scratch.clock.advance(4 * DAY_MS);
  await addRow(scratch.store, delivered, workEntry("alpha-new"));
  const live = (await scratch.store.page()).rows.map((row) => row.code);
  assert.equal(live.length, 20);
  assert.deepEqual(live.slice(0, 2), ["alpha-new", "alpha-old-22"]);
  assert.deepEqual((await scratch.store.archivedRows(delivered)).rows.map((row) => row.code).sort(), ["alpha-old-1", "alpha-old-2", "alpha-old-3"]);
});

async function rowArchivedAt(code: string, archivedAt: Date): Promise<string> {
  const now = scratch.clock.time;
  scratch.clock.set(archivedAt);
  const row = await addRow(scratch.store, sectionId, workEntry(code));
  await scratch.store.archiveRow(row.id, { writer: WRITER });
  scratch.clock.set(now);
  return row.id;
}

function monthsBefore(time: Date, months: number, extraDays = 0): Date {
  const moved = new Date(time);
  moved.setUTCMonth(moved.getUTCMonth() - months);
  return new Date(moved.getTime() - extraDays * DAY_MS);
}

test("a row archived six months and a day ago is deleted by the sweep and one archived five months ago is kept", async () => {
  const now = scratch.clock.time;
  const expired = await rowArchivedAt("alpha-expired", monthsBefore(now, 6, 1));
  const kept = await rowArchivedAt("alpha-kept", monthsBefore(now, 5));
  const answer = await scratch.store.purge({ dryRun: false, writer: WRITER });
  assert.deepEqual(answer.purged.map((item) => item.item), [expired]);
  assert.deepEqual(readTable(scratch.home, "content").map((row) => `r${String(row.id)}`), [kept]);
  assert.ok(!readTable(scratch.home, "content").some((row) => `r${String(row.id)}` === expired));
});

test("a purge dry run lists exactly the rows the sweep would delete and deletes none", async () => {
  const now = scratch.clock.time;
  scratch.clock.set(monthsBefore(now, 7));
  const old = await addRow(scratch.store, sectionId, workEntry("alpha-expired"));
  scratch.clock.set(monthsBefore(now, 6, 2));
  await scratch.store.archiveRow(old.id, { writer: WRITER });
  scratch.clock.set(now);
  const dryRun = await scratch.store.purge({ dryRun: true, writer: WRITER });
  assert.deepEqual(dryRun.purged.map((item) => item.item), [old.id]);
  assert.equal(readTable(scratch.home, "content").length, 1);
  assert.deepEqual((await scratch.store.purge({ dryRun: false, writer: WRITER })).purged.map((item) => item.item), [old.id]);
  assert.equal(readTable(scratch.home, "content").length, 0);
});

test("a restored row that is archived again counts six months from its second archiving", async () => {
  const now = scratch.clock.time;
  const row = await rowArchivedAt("alpha-again", monthsBefore(now, 7));
  scratch.clock.set(monthsBefore(now, 2));
  await scratch.store.restoreRow(row, { writer: WRITER });
  await scratch.store.archiveRow(row, { writer: WRITER });
  scratch.clock.set(now);
  assert.deepEqual((await scratch.store.purge({ dryRun: true, writer: WRITER })).purged, []);
});

test("the journal still holds a purged row's record after the purge", async () => {
  const now = scratch.clock.time;
  const row = await rowArchivedAt("alpha-gone", monthsBefore(now, 6, 1));
  await scratch.store.purge({ dryRun: false, writer: WRITER });
  const journal = readTable(scratch.home, "journal").filter((entry) => entry.item === row);
  assert.deepEqual(journal.map((entry) => entry.action), ["add", "archive", "purge"]);
  assert.match(String(journal.at(-1)!.before), /alpha-gone/);
});

test("a purged section takes everything archived inside it", async () => {
  const now = scratch.clock.time;
  scratch.clock.set(monthsBefore(now, 7));
  const subsection = await createSection(scratch.store, tabId, "Oven work", sectionId);
  await addRow(scratch.store, subsection, workEntry("alpha-inside"));
  await scratch.store.archiveSection(sectionId, { writer: WRITER });
  scratch.clock.set(now);
  await scratch.store.purge({ dryRun: false, writer: WRITER });
  assert.deepEqual(readTable(scratch.home, "section"), []);
  assert.deepEqual(readTable(scratch.home, "content"), []);
});

test("an epic save is refused when the epic changed since it was loaded and the answer carries the current one", async () => {
  const epics = await createSection(scratch.store, await createTab(scratch.store, "Epics"), "Epics");
  const loaded = await addRow(scratch.store, epics, { kind: "epic", text: "Open a second bakery" });
  scratch.clock.advance(1000);
  const elsewhere = await scratch.store.replaceRow(loaded.id, { writer: WRITER, row: { text: "Open a third bakery" }, loadedChangedAt: loaded.changedAt });
  assert.equal(elsewhere.outcome, "done");
  const late = await scratch.store.replaceRow(loaded.id, { writer: "the Lord", row: { text: "My words" }, loadedChangedAt: loaded.changedAt });
  assert.equal(late.outcome, "refused");
  assert.equal(late.row?.text, "Open a third bakery");
});

test("the listing marks archived sections, gives exact dates, and its token changes on create, archive and restore", async () => {
  const tokens = [await token(scratch.store)];
  const other = await createSection(scratch.store, tabId, "Needs you");
  tokens.push(await token(scratch.store));
  await scratch.store.archiveSection(other, { writer: WRITER });
  tokens.push(await token(scratch.store));
  const listing = await scratch.store.listing();
  assert.equal(listing.sections.find((section) => section.id === other)?.archivedAt, scratch.clock.time.toISOString());
  await scratch.store.restoreSection(other, { writer: WRITER });
  tokens.push(await token(scratch.store));
  assert.equal(new Set(tokens).size, 3);
  assert.equal(tokens[3], tokens[1]);
  await addRow(scratch.store, sectionId, workEntry("alpha-oven"));
  assert.equal(await token(scratch.store), tokens[3]);
});

test("the page read holds live rows only with a count of archived rows and archived rows come only when asked for", async () => {
  const live = await addRow(scratch.store, sectionId, workEntry("alpha-live"));
  const gone = await addRow(scratch.store, sectionId, workEntry("alpha-gone"));
  await scratch.store.archiveRow(gone.id, { writer: WRITER });
  const page = await scratch.store.page();
  assert.deepEqual(page.rows.map((row) => row.id), [live.id]);
  assert.deepEqual(page.archivedRowCounts, { [sectionId]: 1 });
  assert.deepEqual((await scratch.store.archivedRows(sectionId)).rows.map((row) => row.id), [gone.id]);
});

test("rows keep their place in the section: a new row goes on top, a replace stays where it was, and a move goes on top of its new section", async () => {
  const queue = await createSection(scratch.store, tabId, "Queued and deferred");
  await addRow(scratch.store, sectionId, workEntry("alpha-oven"));
  await addRow(scratch.store, sectionId, workEntry("alpha-crown"));
  await addRow(scratch.store, sectionId, workEntry("alpha-bell"));
  await addRow(scratch.store, queue, workEntry("alpha-sign", "queued"));
  scratch.clock.advance(DAY_MS);
  await addRow(scratch.store, sectionId, workEntry("alpha-crown", "reviewing"));
  assert.deepEqual(await codesIn(sectionId), ["alpha-bell", "alpha-crown", "alpha-oven"]);
  await addRow(scratch.store, queue, workEntry("alpha-oven", "queued"));
  assert.deepEqual(await codesIn(sectionId), ["alpha-bell", "alpha-crown"]);
  assert.deepEqual(await codesIn(queue), ["alpha-oven", "alpha-sign"]);
});

test("archiving a row that changed since it was loaded is refused and the answer carries the current one", async () => {
  const loaded = await addRow(scratch.store, sectionId, workEntry("alpha-oven"));
  scratch.clock.advance(1000);
  await addRow(scratch.store, sectionId, workEntry("alpha-oven", "reviewing"));
  const late = await scratch.store.archiveRow(loaded.id, { writer: "the Lord", loadedChangedAt: loaded.changedAt });
  assert.equal(late.outcome, "refused");
  assert.equal(late.row?.whereItStands, "reviewing");
  assert.deepEqual(await liveCodes(), ["alpha-oven"]);
});

test("restoring an event line into a full Just happened keeps it live and archives the oldest other line", async () => {
  await addEventLines(scratch, sectionId, 16);
  const [archived] = (await scratch.store.archivedRows(sectionId)).rows;
  const answer = await scratch.store.restoreRow(archived.id, { writer: "the Lord" });
  assert.equal(answer.row?.archivedAt, null);
  const live = (await scratch.store.page()).rows.map((row) => row.text);
  assert.equal(live.length, 15);
  assert.ok(live.includes("event 1"));
  assert.ok(!live.includes("event 2"));
});

test("the page read carries the store's clock", async () => {
  assert.equal((await scratch.store.page()).now, scratch.clock.now().toISOString());
});
