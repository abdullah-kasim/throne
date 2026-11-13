import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RowFields } from "../../src/web-api-contract/where-i-stand.ts";
import { eq } from "drizzle-orm";
import { IdPrefix, numberOfShortId } from "../../src/where-i-stand-store/row-to-contract.ts";
import { openWhereIStandDatabase } from "../../src/where-i-stand-store/where-i-stand-database.ts";
import { contentTable } from "../../src/where-i-stand-store/where-i-stand.schema.ts";
import { WhereIStandStore } from "../../src/where-i-stand-store/where-i-stand.store.ts";

export const FIXTURE_MARKER = "pagedb-fixture-7c41e9";
export const PINNED_NOW = new Date("2026-11-12T15:00:00.000Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

export const FIXTURE_TABS: readonly { readonly name: string; readonly sections: readonly string[] }[] = [
  { name: "Now", sections: ["Needs you", "Just happened", "In flight"] },
  { name: "Epics", sections: ["Epics"] },
  { name: "Queue", sections: ["Queued and deferred", "Parked ideas"] },
  { name: "Delivered", sections: ["Delivered, not on GitHub"] },
  { name: "Pull requests", sections: ["On GitHub"] },
];

export const SUBSECTION = { parent: "In flight", name: "Oven work" };

interface FixtureRow {
  readonly section: string;
  readonly fields: RowFields;
  readonly writtenAgo: number;
  readonly changedAgo?: number;
  readonly archivedAgo?: number;
}

function work(code: string, title: string, whereItStands: string, links = `no pull request · branch ${code} · Ticket no ticket`): RowFields {
  return { kind: "work", code, links, workKind: `new page — ${title}`, whereItStands };
}

function writtenLine(code: string, ago: number): string {
  return `Written by ${code}, ${new Date(PINNED_NOW.getTime() - ago).toISOString().slice(0, 10)}`;
}

function withWrittenLine(fields: RowFields, ago: number): RowFields {
  return { ...fields, freeLines: [writtenLine(fields.code!, ago)] };
}

const deliveredRows: FixtureRow[] = Array.from({ length: 24 }, (_unused, index) => {
  const ago = index < 3 ? (index + 1) * 5 * HOUR : (index - 1) * DAY;
  return { section: "Delivered, not on GitHub", fields: withWrittenLine(work(`alpha-delivered-${index + 1}`, `Bake batch ${index + 1}`, "on local main", `no pull request · \`${(0xa1b2c00 + index).toString(16)}\` · Ticket no ticket`), ago), writtenAgo: ago };
});

const eventRows: FixtureRow[] = Array.from({ length: 17 }, (_unused, index) => ({
  section: "Just happened",
  fields: { kind: "event", text: `delivered batch ${17 - index}: the ovens were checked` },
  writtenAgo: index * 47 * MINUTE + 10_000,
}));

const FIXTURE_ROWS: readonly FixtureRow[] = [
  { section: "Needs you", fields: withWrittenLine(work("alpha-giftcard", "Add a gift card page", "waiting for your look", "Forgejo https://forge.example.com/shop/storefront/pulls/8 · GitHub not on GitHub yet · Ticket no ticket"), 10_000), writtenAgo: 10_000 },
  { section: "Needs you", fields: work("alpha-bow", "Teach the court to bow", "which bow?"), writtenAgo: 30 * MINUTE },
  { section: "In flight", fields: { ...work("alpha-oven", "Keep the oven warm", "building"), workKind: "bug fix — Keep the oven warm" }, writtenAgo: 5 * DAY, changedAgo: 2 * HOUR },
  { section: "In flight", fields: { ...work("alpha-crown", "Polish the crown", "testing"), workKind: "throne — Polish the crown" }, writtenAgo: 26 * HOUR },
  { section: "In flight", fields: work("alpha-awning", "Hang the shop awning", "first draft"), writtenAgo: 10 * DAY },
  { section: "In flight", fields: work("alpha-sign", "Paint the sign", "paused"), writtenAgo: 3 * 7 * DAY, archivedAgo: 2 * 7 * DAY },
  { section: "In flight", fields: work("alpha-bell", "Fit a door bell", "dropped"), writtenAgo: 6 * MONTH, archivedAgo: 5 * MONTH },
  { section: SUBSECTION.name, fields: work("alpha-thermostat", "Calibrate the thermostat", "measuring"), writtenAgo: 3 * DAY },
  { section: SUBSECTION.name, fields: work("alpha-tray", "Order baking trays", "waiting on the supplier"), writtenAgo: 2 * MONTH },
  { section: "Queued and deferred", fields: work("alpha-flour", "Order rye flour", "queued"), writtenAgo: 3 * 7 * DAY },
  { section: "Queued and deferred", fields: work("alpha-menu", "Print a new menu", "deferred until spring"), writtenAgo: 2 * MONTH },
  { section: "Queued and deferred", fields: work("alpha-van", "Lease a delivery van", "queued"), writtenAgo: 7 * MONTH },
  { section: "Parked ideas", fields: work("alpha-kiosk", "Open a kiosk", "parked"), writtenAgo: 4 * MONTH, archivedAgo: 3 * MONTH },
  { section: "Parked ideas", fields: work("alpha-cafe", "Add a cafe corner", "parked"), writtenAgo: 2 * MONTH, archivedAgo: 6 * DAY },
  { section: "On GitHub", fields: work("alpha-loyalty", "Add a loyalty card", "waiting on review", "Forgejo https://forge.example.com/shop/storefront/pulls/12 · GitHub not on GitHub yet · Ticket no ticket"), writtenAgo: 4 * DAY },
  { section: "On GitHub", fields: work("alpha-receipts", "Print receipts", "merged", "no pull request · `b2c3d4e` · Ticket no ticket"), writtenAgo: 9 * DAY },
  { section: "On GitHub", fields: work("storefront#21", "Speed up checkout", "review requested"), writtenAgo: 6 * HOUR },
  { section: "Epics", fields: { kind: "epic", text: "Open a second bakery", freeLines: ["Find a street with morning foot traffic."] }, writtenAgo: 2 * MONTH, changedAgo: 3 * DAY },
  { section: "Epics", fields: { kind: "epic", text: "Write the rye cookbook", freeLines: ["Twelve recipes, one per month."] }, writtenAgo: 3 * 7 * DAY },
  { section: "Epics", fields: { kind: "epic", text: "Train a second baker" }, writtenAgo: 2 * HOUR },
  ...deliveredRows,
  ...eventRows,
];

const EXPIRED_ROW: FixtureRow = { section: "Parked ideas", fields: work("alpha-expired", "Sell day-old bread", "parked"), writtenAgo: 7 * MONTH, archivedAgo: 0 };

function sixMonthsAndADayBefore(time: Date): Date {
  const moved = new Date(time);
  moved.setUTCMonth(moved.getUTCMonth() - 6);
  return new Date(moved.getTime() - DAY);
}

type Step = { readonly at: number; readonly run: (store: WhereIStandStore, ids: Map<FixtureRow, string>) => Promise<void> };

function stepsOf(row: FixtureRow, sectionIds: Map<string, string>, archivedAt?: number): Step[] {
  const sectionId = sectionIds.get(row.section)!;
  const now = PINNED_NOW.getTime();
  const steps: Step[] = [
    {
      at: now - row.writtenAgo,
      run: async (store, ids) => {
        const answer = await store.addRow({ sectionId, listingToken: (await store.listing()).listingToken, writer: FIXTURE_MARKER, row: row.fields });
        if (answer.row === undefined) throw new Error(`the fixture could not add ${JSON.stringify(row.fields)}: ${answer.message}`);
        ids.set(row, answer.row.id);
      },
    },
  ];
  if (row.changedAgo !== undefined) {
    steps.push({
      at: now - row.changedAgo,
      run: async (store, ids) => {
        const current = (await store.page()).rows.find((each) => each.id === ids.get(row))!;
        await store.replaceRow(current.id, { writer: FIXTURE_MARKER, row: { whereItStands: row.fields.whereItStands, freeLines: [...(row.fields.freeLines ?? []), "changed after it was written"] }, loadedChangedAt: current.changedAt });
      },
    });
  }
  const archiveAt = archivedAt ?? (row.archivedAgo === undefined ? undefined : now - row.archivedAgo);
  if (archiveAt !== undefined) steps.push({ at: archiveAt, run: async (store, ids) => void (await store.archiveRow(ids.get(row)!, { writer: FIXTURE_MARKER })) });
  return steps;
}

export async function buildFixtureDatabase(throneHome: string): Promise<void> {
  let clockTime = PINNED_NOW.getTime() - 8 * MONTH;
  const ids = new Map<FixtureRow, string>();
  const store = new WhereIStandStore(throneHome, () => new Date(clockTime));
  try {
    const sectionIds = new Map<string, string>();
    for (const tab of FIXTURE_TABS) {
      const created = await store.createTab({ name: tab.name, listingToken: (await store.listing()).listingToken, writer: FIXTURE_MARKER });
      for (const name of tab.sections) {
        const section = await store.createSection({ tabId: created.tab!.id, name, listingToken: (await store.listing()).listingToken, writer: FIXTURE_MARKER });
        sectionIds.set(name, section.section!.id);
      }
    }
    const parent = (await store.listing()).sections.find((section) => section.name === SUBSECTION.parent)!;
    const subsection = await store.createSection({ tabId: parent.tabId, parentId: parent.id, name: SUBSECTION.name, listingToken: (await store.listing()).listingToken, writer: FIXTURE_MARKER });
    sectionIds.set(SUBSECTION.name, subsection.section!.id);
    const steps = FIXTURE_ROWS.flatMap((row) => stepsOf(row, sectionIds)).sort((first, second) => first.at - second.at);
    const expiredSteps = stepsOf(EXPIRED_ROW, sectionIds, sixMonthsAndADayBefore(PINNED_NOW).getTime());
    for (const step of [...steps, ...expiredSteps]) {
      clockTime = step.at;
      await step.run(store, ids);
    }
  } finally {
    await store.onModuleDestroy();
  }
  await placeRowsInListedOrder(throneHome, ids);
}

async function placeRowsInListedOrder(throneHome: string, ids: ReadonlyMap<FixtureRow, string>): Promise<void> {
  const opened = await openWhereIStandDatabase(throneHome);
  try {
    const placesTaken = new Map<string, number>();
    for (const row of FIXTURE_ROWS) {
      const position = placesTaken.get(row.section) ?? 0;
      placesTaken.set(row.section, position + 1);
      const id = numberOfShortId(IdPrefix.Row, ids.get(row) ?? "");
      if (id !== undefined) opened.database.update(contentTable).set({ position }).where(eq(contentTable.id, id)).run();
    }
  } finally {
    opened.close();
  }
}

function entryMarkdown(row: FixtureRow): string {
  const { fields } = row;
  if (fields.kind === "event") return `- ${fields.text}`;
  if (fields.kind === "epic") return [`### ${fields.text}`, ...(fields.freeLines ?? [])].join("\n");
  return [`### ${fields.code}`, `- Links: ${fields.links}`, `- Kind: ${fields.workKind}`, `- Where it stands: ${fields.whereItStands}`, ...(fields.freeLines ?? [])].join("\n");
}

const MARKDOWN_SECTIONS = ["Just happened", "Needs you", "In flight", "Queued and deferred", "Delivered, not on GitHub", "On GitHub", "Epics"];

const LIVE_EVENT_LINES = 15;
const DELIVERED_ROWS_KEPT = 20;

function archivedInTheDatabase(row: FixtureRow): boolean {
  return row.archivedAgo !== undefined || eventRows.indexOf(row) >= LIVE_EVENT_LINES || deliveredRows.indexOf(row) >= DELIVERED_ROWS_KEPT;
}

export function fixtureMarkdownPage(): string {
  const sectionOf = (row: FixtureRow) => (row.section === SUBSECTION.name ? SUBSECTION.parent : row.section);
  const blocks = MARKDOWN_SECTIONS.map((section) => {
    const rows = FIXTURE_ROWS.filter((row) => sectionOf(row) === section && !archivedInTheDatabase(row));
    const separator = section === "Just happened" ? "\n" : "\n\n";
    return [`## ${section}`, ...(rows.length === 0 ? [] : [rows.map(entryMarkdown).join(separator)])].join("\n\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

export function fixtureMarkdownArchive(): string {
  const archived = [...FIXTURE_ROWS, EXPIRED_ROW].filter((row) => archivedInTheDatabase(row) && row.fields.kind === "work");
  const sections = [...new Set(archived.map((row) => row.section))];
  return `${sections.map((section) => [`## ${section}`, archived.filter((row) => row.section === section).map(entryMarkdown).join("\n\n")].join("\n\n")).join("\n\n")}\n`;
}

export function fixturePullRequestRecords(): unknown {
  const opened = new Date(PINNED_NOW.getTime() - 2 * DAY).toISOString();
  const pull = (number: number) => ({ url: `https://forge.example.com/shop/storefront/pulls/${number}`, number, state: "open" });
  const row = (group: string, title: string, number: number) => ({ group, repository: "shop/storefront", title, ticket: "", ticket_url: "", kind: "new page", forgejo: pull(number), github: null, head_commits: "" });
  const checks = { passing: 4, failing: 0, running: 1 };
  return {
    read_at: new Date(PINNED_NOW.getTime() - 3 * MINUTE).toISOString(),
    problems: [],
    changes: ["storefront#12 moved to waiting on review"],
    rows: [row("Waiting on review", "Add a loyalty card", 12), row("Forgejo only", "Add a gift card page", 8)],
    waiting_for_review: [{ repository: "shop/storefront", number: 30, url: "https://forge.example.com/shop/storefront/pulls/30", title: "Tidy the till code", author: "a-teammate", checks, waiting_on: "you", created_at: opened }],
    teammates: [{ repository: "shop/storefront", number: 31, url: "https://forge.example.com/shop/storefront/pulls/31", title: "Add opening hours", author: "a-teammate", checks, draft: false, review: "approved", updated_at: opened }],
  };
}

export async function seedFixtureHome(throneHome: string, cacheHome: string, options: { readonly database: boolean }): Promise<void> {
  await mkdir(throneHome, { recursive: true });
  const files: [string, string][] = [
    [path.join(throneHome, "where-i-stand.md"), fixtureMarkdownPage()],
    [path.join(throneHome, "where-i-stand.archive.md"), fixtureMarkdownArchive()],
    [path.join(cacheHome, "where-i-stand", "where-i-stand-prs.json"), JSON.stringify(fixturePullRequestRecords(), null, 2)],
  ];
  await mkdir(path.join(cacheHome, "where-i-stand"), { recursive: true });
  for (const [file, text] of files) {
    await writeFile(file, text);
    await utimes(file, PINNED_NOW, PINNED_NOW);
  }
  if (options.database) await buildFixtureDatabase(throneHome);
}
