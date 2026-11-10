import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import { listEntries, PageSection, sectionHeadingOf } from "./page-frame.ts";
import { readJournal } from "./page-journal.ts";
import { archivePathIn } from "./page-store.ts";
import { trimPage } from "./page-trim.ts";
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

const DELIVERED = sectionHeadingOf(PageSection.DeliveredNotOnGitHub);
const NOW = new Date("2026-10-14T09:30:00.000Z");
const OLD_DATE = "2026-09-01";
const YESTERDAY = "2026-10-13";
const FOUR_DAYS_AGO = "2026-10-10";

function deliveredEntry(identity: string, date: string | undefined): string {
  const written = date === undefined ? "Written by alpha-bakery-01." : `Written by alpha-bakery-01, ${date} 08:00.`;
  return entry(identity, `- Links: none\n- Kind: delivered\n- Where it stands: merged\n- ${written}`);
}

function deliveredEntries(count: number, date: (position: number) => string | undefined, prefix = "bake"): string {
  return Array.from({ length: count }, (_unused, position) => deliveredEntry(`${prefix}${position + 1}`, date(position))).join("");
}

function deliveredIdentities(page: string): string[] {
  return listEntries(page)
    .filter((pageEntry) => pageEntry.section === PageSection.DeliveredNotOnGitHub)
    .map((pageEntry) => pageEntry.identity);
}

function numbered(prefix: string, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_unused, offset) => `${prefix}${from + offset}`);
}

async function startPage(room: PageRoom, page: string): Promise<void> {
  await mkdir(room.dataHome, { recursive: true });
  await editThePageDirectly(room, () => page);
}

async function readArchive(room: PageRoom): Promise<string> {
  return readFile(archivePathIn(room.dataHome), "utf8");
}

test("the delivered section keeps only its newest twenty entries when all are old", () => {
  const trimmed = trimPage(pageWith({ [DELIVERED]: deliveredEntries(23, () => OLD_DATE) }), NOW);

  assert.deepEqual(deliveredIdentities(trimmed.page), numbered("bake", 1, 20));
  assert.deepEqual(trimmed.archived.map((archived) => archived.identity), numbered("bake", 21, 23));
});

test("an entry younger than three days is never archived even past twenty", () => {
  const trimmed = trimPage(
    pageWith({ [DELIVERED]: deliveredEntries(24, (position) => (position < 22 ? YESTERDAY : FOUR_DAYS_AGO)) }),
    NOW,
  );

  assert.deepEqual(deliveredIdentities(trimmed.page), numbered("bake", 1, 22));
  assert.deepEqual(trimmed.archived.map((archived) => archived.identity), ["bake23", "bake24"]);
});

test("an entry with no readable date counts as old", () => {
  const trimmed = trimPage(
    pageWith({ [DELIVERED]: deliveredEntries(21, (position) => (position === 20 ? undefined : YESTERDAY)) }),
    NOW,
  );

  assert.deepEqual(trimmed.archived.map((archived) => archived.identity), ["bake21"]);
});

test("sections other than delivered are never trimmed", () => {
  const page = pageWith({
    "## In flight": deliveredEntries(25, () => OLD_DATE, "flight"),
    "## On GitHub": deliveredEntries(25, () => OLD_DATE, "github"),
    "## Epics": deliveredEntries(25, () => OLD_DATE, "epic"),
  });

  assert.deepEqual(trimPage(page, NOW), { page, archived: [] });
});

test("the archive receives whole entries newest first under the section they left", async (t) => {
  const room = await pageRoom(t);
  await startPage(room, pageWith({ [DELIVERED]: deliveredEntries(22, () => OLD_DATE) }));
  await runWhereIStand(["note", "launched breadlabels"], room.dependencies);
  await editThePageDirectly(room, (content) =>
    content.replace(`${DELIVERED}\n`, `${DELIVERED}\n${deliveredEntries(2, () => OLD_DATE, "cake")}`),
  );
  await runWhereIStand(["note", "launched cakelabels"], room.dependencies);

  const archive = await readArchive(room);
  assert.deepEqual(archive.split("\n").filter((line) => line.startsWith("#")), [DELIVERED, ...numbered("### bake", 19, 22)]);
  for (const identity of numbered("bake", 19, 22)) {
    assert.ok(archive.includes(deliveredEntry(identity, OLD_DATE).trim()), identity);
  }
  const page = await readPageOrEmptyFrame(room);
  assert.deepEqual(deliveredIdentities(page), [...numbered("cake", 1, 2), ...numbered("bake", 1, 18)]);
});

test("a hand edit under the lock is trimmed when the lock is released", async (t) => {
  const room = await pageRoom(t);

  assert.equal(
    await lockEditAndRelease(room, () => pageWith({ [DELIVERED]: deliveredEntries(21, () => OLD_DATE) })),
    WhereIStandExitCode.Done,
  );

  assert.deepEqual(deliveredIdentities(await readPageOrEmptyFrame(room)), numbered("bake", 1, 20));
  assert.match(await readArchive(room), /### bake21\n/);
  assert.deepEqual((await readJournal(room.dataHome)).at(-1)?.archived, ["bake21"]);
});

test("a note trims the page and the journal records what was archived", async (t) => {
  const room = await pageRoom(t);
  await startPage(room, pageWith({ [DELIVERED]: deliveredEntries(21, () => OLD_DATE) }));

  assert.equal(await runWhereIStand(["note", "launched breadlabels"], room.dependencies), WhereIStandExitCode.Done);

  assert.deepEqual(deliveredIdentities(await readPageOrEmptyFrame(room)), numbered("bake", 1, 20));
  const record = (await readJournal(room.dataHome)).at(-1);
  assert.equal(record?.action, "note");
  assert.deepEqual(record?.archived, ["bake21"]);
});

test("a save from the page trims it", async (t) => {
  const room = await pageRoom(t);
  const epic = "### Bakery\n\nOpen the shop.";
  await startPage(room, pageWith({ [DELIVERED]: deliveredEntries(21, () => OLD_DATE), "## Epics": `\n${epic}\n` }));

  assert.equal(
    await runWhereIStand(["save"], {
      ...room.dependencies,
      now: () => WRITTEN_AT,
      readStandardInput: async () => JSON.stringify({ loaded: epic, edited: "### Bakery\n\nOpen the shop by spring." }),
    }),
    WhereIStandExitCode.Done,
  );

  const page = await readPageOrEmptyFrame(room);
  assert.match(page, /Open the shop by spring\./);
  assert.deepEqual(deliveredIdentities(page), numbered("bake", 1, 20));
  assert.match(await readArchive(room), /### bake21\n/);
});
