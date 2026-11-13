import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixtureMarkdownArchive, fixtureMarkdownPage } from "../../scripts/where-i-stand-evidence/fixture.ts";
import { readTable } from "../where-i-stand-store/where-i-stand-store.test-support.ts";
import { WhereIStandStore } from "../where-i-stand-store/where-i-stand.store.ts";
import { differencesFromMarkdownPage } from "./compare-imported-page.ts";
import { importMarkdownPage, TABS_OF_TODAYS_PAGE } from "./import-markdown-page.ts";
import { readMarkdownPage } from "./markdown-page-reader.ts";
import { runWhereIStandImport } from "./where-i-stand-import-runtime.ts";

const IMPORT_TIME = new Date("2026-11-13T09:00:00.000Z");
const PAGE_MODIFIED = new Date("2026-11-10T08:30:00.000Z");
const NEWEST_NOTE = "2026-11-12T14:50:00.000Z";
const ARCHIVED_BY_THE_TRIM = "2026-11-01T07:00:00.000Z";

interface Scratch {
  readonly home: string;
  readonly files: { readonly page: string; readonly archive: string; readonly journal: string };
  close(): Promise<void>;
}

async function scratchWithFixtureFiles(): Promise<Scratch> {
  const home = await mkdtemp(path.join(os.tmpdir(), "where-i-stand-import-"));
  const files = { page: path.join(home, "where-i-stand.md"), archive: path.join(home, "where-i-stand.archive.md"), journal: path.join(home, "where-i-stand.journal.jsonl") };
  await writeFile(files.page, fixtureMarkdownPage());
  await writeFile(files.archive, fixtureMarkdownArchive());
  const journal = [
    { at: "2026-11-12T10:00:00.000Z", writer: "alpha-one", action: "note" },
    { at: ARCHIVED_BY_THE_TRIM, writer: "alpha-two", action: "write", archived: ["alpha-delivered-24"] },
    { at: NEWEST_NOTE, writer: "alpha-three", action: "note" },
  ];
  await writeFile(files.journal, journal.map((line) => JSON.stringify(line)).join("\n") + "\n");
  await utimes(files.page, PAGE_MODIFIED, PAGE_MODIFIED);
  await utimes(files.archive, PAGE_MODIFIED, PAGE_MODIFIED);
  return { home, files, close: () => rm(home, { recursive: true, force: true }) };
}

async function storedPageOf(home: string) {
  const store = new WhereIStandStore(home, () => IMPORT_TIME);
  try {
    const page = await store.page();
    const archived = await Promise.all(page.listing.sections.map(async (section) => ({ section, rows: (await store.archivedRows(section.id)).rows })));
    return { page, archived };
  } finally {
    await store.onModuleDestroy();
  }
}

function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("B8.1 every entry of the Markdown page is a live row in its section with its fields and free lines, and every archive entry is an archived row", async () => {
  const scratch = await scratchWithFixtureFiles();
  try {
    await importMarkdownPage(scratch.home, scratch.files, IMPORT_TIME);
    const { page, archived } = await storedPageOf(scratch.home);
    const markdownEntries = readMarkdownPage(fixtureMarkdownPage());
    assert.equal(page.rows.length, markdownEntries.length);
    const tabNameOf = (sectionId: string) => {
      const section = page.listing.sections.find((each) => each.id === sectionId)!;
      return { section: section.name, tab: page.listing.tabs.find((tab) => tab.id === section.tabId)!.name };
    };
    for (const { tab, sections } of TABS_OF_TODAYS_PAGE) {
      for (const section of sections) assert.ok(page.listing.sections.some((each) => tabNameOf(each.id).tab === tab && each.name === section), `${section} on ${tab}`);
    }
    const giftCard = page.rows.find((row) => row.code === "alpha-giftcard")!;
    assert.deepEqual(tabNameOf(giftCard.sectionId), { section: "Needs you", tab: "Now" });
    assert.equal(giftCard.links, "Forgejo https://forge.example.com/shop/storefront/pulls/8 · GitHub not on GitHub yet · Ticket no ticket");
    assert.equal(giftCard.workKind, "new page — Add a gift card page");
    assert.equal(giftCard.whereItStands, "waiting for your look");
    assert.deepEqual(giftCard.freeLines, ["Written by alpha-giftcard, 2026-11-12"]);
    const epic = page.rows.find((row) => row.text === "Open a second bakery")!;
    assert.equal(epic.kind, "epic");
    assert.deepEqual(tabNameOf(epic.sectionId), { section: "Epics", tab: "Epics" });
    assert.ok(epic.freeLines.includes("Find a street with morning foot traffic."));
    const archivedCodes = archived.flatMap(({ rows }) => rows.map((row) => row.code)).sort();
    const archiveEntries = readMarkdownPage(fixtureMarkdownArchive()).map((entry) => entry.identity).sort();
    assert.deepEqual(archivedCodes, archiveEntries);
    const parked = archived.find(({ section }) => section.name === "Parked ideas")!;
    assert.equal(tabNameOf(parked.section.id).tab, "Now");
    const trimmed = archived.flatMap(({ rows }) => rows).find((row) => row.code === "alpha-delivered-24")!;
    assert.equal(trimmed.archivedAt, ARCHIVED_BY_THE_TRIM);
    const withoutJournalTime = archived.flatMap(({ rows }) => rows).find((row) => row.code === "alpha-sign")!;
    assert.equal(withoutJournalTime.archivedAt, IMPORT_TIME.toISOString());
  } finally {
    await scratch.close();
  }
});

test("B8.2 written dates come from each entry's written line, and an entry with none is marked as an estimate", async () => {
  const scratch = await scratchWithFixtureFiles();
  try {
    await importMarkdownPage(scratch.home, scratch.files, IMPORT_TIME);
    const { page } = await storedPageOf(scratch.home);
    const giftCard = page.rows.find((row) => row.code === "alpha-giftcard")!;
    assert.equal(giftCard.writtenAt, "2026-11-12T00:00:00.000Z");
    assert.equal(giftCard.writtenBy, "alpha-giftcard");
    assert.equal(giftCard.writtenDateIsEstimate, false);
    const bow = page.rows.find((row) => row.code === "alpha-bow")!;
    assert.equal(bow.writtenAt, PAGE_MODIFIED.toISOString());
    assert.equal(bow.writtenDateIsEstimate, true);
    const events = page.rows.filter((row) => row.kind === "event");
    assert.equal(events[0]!.writtenAt, NEWEST_NOTE);
    assert.equal(events[0]!.writtenDateIsEstimate, false);
    assert.equal(events[2]!.writtenAt, PAGE_MODIFIED.toISOString());
    assert.equal(events[2]!.writtenDateIsEstimate, true);
  } finally {
    await scratch.close();
  }
});

test("B8.3 the imported page shows the same entries under the same sections in the same order as the Markdown page", async () => {
  const scratch = await scratchWithFixtureFiles();
  try {
    await importMarkdownPage(scratch.home, scratch.files, IMPORT_TIME);
    const { page } = await storedPageOf(scratch.home);
    assert.deepEqual(differencesFromMarkdownPage(fixtureMarkdownPage(), page), []);
    const printed: string[] = [];
    assert.equal(await runWhereIStandImport(["--compare", "--page", scratch.files.page], scratch.home, (line) => printed.push(line)), 0);
    const swapped = fixtureMarkdownPage().replace("### alpha-oven", "### alpha-swap").replace("### alpha-crown", "### alpha-oven").replace("### alpha-swap", "### alpha-crown");
    await writeFile(scratch.files.page, swapped);
    assert.equal(await runWhereIStandImport(["--compare", "--page", scratch.files.page], scratch.home, (line) => printed.push(line)), 1);
    assert.match(printed.at(-1)!, /^In flight, place 2:/);
  } finally {
    await scratch.close();
  }
});

test("B8.4 running the import twice changes nothing the second time", async () => {
  const scratch = await scratchWithFixtureFiles();
  try {
    const printed: string[] = [];
    const run = () => runWhereIStandImport(["--page", scratch.files.page, "--archive", scratch.files.archive, "--journal", scratch.files.journal], scratch.home, (line) => printed.push(line));
    assert.equal(await run(), 0);
    const tables = () => (["content", "section", "journal"] as const).map((table) => readTable(scratch.home, table));
    const afterFirst = tables();
    assert.equal(await run(), 0);
    assert.deepEqual(tables(), afterFirst);
    assert.equal(printed.at(-1), "The page was imported before; nothing was changed.");
  } finally {
    await scratch.close();
  }
});

test("B8.5 the Markdown files are byte-identical after the import", async () => {
  const scratch = await scratchWithFixtureFiles();
  try {
    const files = [scratch.files.page, scratch.files.archive, scratch.files.journal];
    const before = await Promise.all(files.map(async (file) => checksum(await readFile(file, "utf8"))));
    await importMarkdownPage(scratch.home, scratch.files, IMPORT_TIME);
    const after = await Promise.all(files.map(async (file) => checksum(await readFile(file, "utf8"))));
    assert.deepEqual(after, before);
  } finally {
    await scratch.close();
  }
});

test("an imported row's age is the age it had on the Markdown page, not the time of the import", async () => {
  const scratch = await scratchWithFixtureFiles();
  try {
    await importMarkdownPage(scratch.home, scratch.files, IMPORT_TIME);
    const { page, archived } = await storedPageOf(scratch.home);
    const rows = [...page.rows, ...archived.flatMap(({ rows: archivedRows }) => archivedRows)];
    for (const row of rows) assert.equal(row.changedAt, row.writtenAt, `${row.code ?? row.text}`);
    assert.equal(page.rows.find((row) => row.code === "alpha-giftcard")!.changedAt, "2026-11-12T00:00:00.000Z");
    assert.equal(page.rows.find((row) => row.code === "alpha-bow")!.changedAt, PAGE_MODIFIED.toISOString());
  } finally {
    await scratch.close();
  }
});
