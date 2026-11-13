import { entryEnd, ENTRY_HEADING_LEVEL, headingLevelOf, headingTextOf, SECTION_HEADING_LEVEL } from "@contract/page-entry-lines.ts";
import type { PullRequestRecords, StoredPage, StoredRow, StoredSection, StoredTab } from "@contract/where-i-stand.ts";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { App } from "@/app/app";

const PAGE_PATH = "/throne/where-i-stand/";
const API_PATH = "/throne/api/";
const FILE_TIME = "2026-11-05T04:00:00.000Z";

export const EPIC_CHANGED_WORDS = "Not saved: this epic changed since it was loaded, and nothing was overwritten. Here is the current one.";

export const EPICS_HASH = "#epics";
export const BAKERY = "Open a second bakery";
export const COOKBOOK = "Write the rye cookbook";
export const BAKERY_EPIC = `### ${BAKERY}\nFind a street with morning foot traffic.`;

export const GIFT_CARD_ADDRESS = "https://forge.example.com/shop/storefront/pulls/8";
export const LOYALTY_ADDRESS = "https://forge.example.com/shop/storefront/pulls/12";
export const THRONE_ADDRESS = "https://forge.example.com/court/throne-mirror/pulls/3";

export const SAMPLE_MARKDOWN = `## Just happened

- delivered menu: the menu skill sorts

## Needs you

### alpha-giftcard
- Links: Forgejo ${GIFT_CARD_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — Add a gift card page
- Where it stands: waiting for your look

### alpha-bow
- Links: Forgejo ${THRONE_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: throne — Teach the court to bow
- Where it stands: which bow?

## In flight

### alpha-oven
- Links: no pull request · branch alpha-oven · Ticket no ticket
- Kind: bug fix — Keep the oven warm
- Where it stands: building

## Queued and deferred

### alpha-flour
- Links: no pull request · branch alpha-flour · Ticket no ticket
- Kind: new page — Order rye flour
- Where it stands: queued

## Delivered, not on GitHub

### alpha-menu
- Links: no pull request · \`a1b2c3d\` · Ticket no ticket
- Kind: skill change — Teach the menu skill to sort
- Where it stands: on local main

### alpha-crown
- Links: no pull request · throne · Ticket no ticket
- Kind: throne — Polish the crown
- Where it stands: on local main

## On GitHub

### alpha-loyalty
- Links: Forgejo ${LOYALTY_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — Add a loyalty card
- Where it stands: waiting on review

### alpha-receipts
- Links: no pull request · \`b2c3d4e\` · Ticket no ticket
- Kind: bug fix — Print receipts
- Where it stands: merged

## Epics

### Open a second bakery
Find a street with morning foot traffic.

### Write the rye cookbook
- Kind: throne — not a real kind
`;

type WorkRecord = PullRequestRecords["rows"][number];

export function workRecord(fields: Partial<WorkRecord>): WorkRecord {
  return { group: "", repository: "shop/storefront", title: "", ticket: "", ticket_url: "", kind: "", forgejo: null, github: null, head_commits: "", ...fields };
}

export function recordsWith(fields: Partial<PullRequestRecords> = {}): PullRequestRecords {
  return { read_at: new Date().toISOString(), problems: [], changes: [], rows: [], waiting_for_review: [], teammates: [], ...fields };
}

export const SAMPLE_RECORDS = recordsWith({
  rows: [
    workRecord({ group: "Waiting on review", title: "Add a loyalty card", forgejo: { url: LOYALTY_ADDRESS, number: 12, state: "open" } }),
    workRecord({ group: "Forgejo only", title: "Add a gift card page", forgejo: { url: GIFT_CARD_ADDRESS, number: 8, state: "open" } }),
  ],
});

interface HeldAnswer {
  readonly release: () => void;
}

export type WriteBody = Record<string, unknown> & { readonly address: string; readonly method: string };

const LISTING_TOKEN = "fake-listing-token";
const FRAME: readonly (readonly [string, readonly string[]])[] = [
  ["Now", ["Needs you", "Just happened", "In flight"]],
  ["Epics", ["Epics"]],
  ["Queue", ["Queued and deferred"]],
  ["Delivered", ["Delivered, not on GitHub"]],
  ["Pull requests", ["On GitHub"]],
];
const EPICS = "Epics";
const ENTRY_FIELD_PATTERN = /^\s*[-*+]\s+(Links|Kind|Where it stands):\s*(.*)$/;

interface MarkdownEntry {
  readonly section: string;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
  readonly kind: StoredRow["kind"];
  readonly identity: string;
}

function writeAnswer(outcome: "done" | "refused", message: string, row?: StoredRow): Response {
  return Response.json({ outcome, message, ...(row === undefined ? {} : { row }) }, { status: 200 });
}

function readMarkdownEntries(markdown: string): MarkdownEntry[] {
  const lines = markdown.split("\n");
  const entries: MarkdownEntry[] = [];
  let section = "";
  for (let position = 0; position < lines.length; position += 1) {
    const level = headingLevelOf(lines[position]);
    if (level === SECTION_HEADING_LEVEL) section = headingTextOf(lines[position]);
    else if (level === ENTRY_HEADING_LEVEL) {
      const end = entryEnd(lines, position);
      entries.push({ section, start: position, end, lines: lines.slice(position, end), kind: section === EPICS ? "epic" : "work", identity: headingTextOf(lines[position]) });
      position = end - 1;
    } else if (lines[position].trim() !== "" && section !== "") {
      entries.push({ section, start: position, end: position + 1, lines: [lines[position]], kind: "event", identity: lines[position].replace(/^\s*-\s+/, "") });
    }
  }
  return entries;
}

function rowFieldsOf(entry: MarkdownEntry) {
  if (entry.kind === "event") return { code: null, links: null, workKind: null, whereItStands: null, freeLines: [], text: entry.identity };
  if (entry.kind === "epic") return { code: null, links: null, workKind: null, whereItStands: null, freeLines: entry.lines.slice(1), text: entry.identity };
  const fields = new Map<string, string>();
  const freeLines = entry.lines.slice(1).filter((line) => {
    const field = ENTRY_FIELD_PATTERN.exec(line);
    if (field !== null && !fields.has(field[1])) fields.set(field[1], field[2].trim());
    return field === null;
  });
  return { code: entry.identity, links: fields.get("Links") ?? null, workKind: fields.get("Kind") ?? null, whereItStands: fields.get("Where it stands") ?? null, freeLines, text: "" };
}

export class FakeBackend {
  markdown: string;
  records: unknown;
  recordsAnswer: Response | null = null;
  pageIsUnreadable = false;
  networkIsDown = false;
  answerToNextSaves: ((body: WriteBody) => Promise<Response> | Response) | null = null;
  holdPageReads = false;
  readonly heldPageReads: HeldAnswer[] = [];
  holdRecordsReads = false;
  readonly heldRecordsReads: HeldAnswer[] = [];
  readonly saveBodies: WriteBody[] = [];
  readonly addresses: string[] = [];
  readonly archivedRows: StoredRow[] = [];
  answersOnTheirWay = 0;
  private readonly rowIds = new Map<string, string>();
  private readonly lastSeen = new Map<string, { text: string; writtenAt: string; changedAt: string }>();
  private lastTime = new Date(FILE_TIME).getTime();
  private nextId = 1;

  constructor(markdown = SAMPLE_MARKDOWN, records: unknown = SAMPLE_RECORDS) {
    this.markdown = markdown;
    this.records = records;
  }

  private freshTime(): string {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    return new Date(this.lastTime).toISOString();
  }

  private sectionNames(): string[] {
    const named = readMarkdownEntries(this.markdown).map(({ section }) => section);
    const sectionLines = this.markdown.split("\n").filter((line) => headingLevelOf(line) === SECTION_HEADING_LEVEL).map(headingTextOf);
    const framed = FRAME.flatMap(([, sections]) => sections);
    return [...new Set([...framed, ...sectionLines, ...named])];
  }

  sectionId(name: string): string {
    return `s${this.sectionNames().indexOf(name) + 1}`;
  }

  private tabs(): StoredTab[] {
    return FRAME.map(([name], position) => ({ id: `t${position + 1}`, name, position, writtenAt: FILE_TIME, writtenBy: "fixture", changedAt: FILE_TIME, changedBy: "fixture", archivedAt: null, archivedBy: null }));
  }

  private sections(): StoredSection[] {
    return this.sectionNames().map((name, position) => {
      const tabPosition = FRAME.findIndex(([, sections]) => sections.includes(name));
      return { id: this.sectionId(name), tabId: `t${Math.max(tabPosition, 0) + 1}`, parentId: null, name, position, writtenAt: FILE_TIME, writtenBy: "fixture", changedAt: FILE_TIME, changedBy: "fixture", archivedAt: null, archivedBy: null };
    });
  }

  private rowOf(entry: MarkdownEntry, occurrence: number): StoredRow {
    const key = `${entry.section}\n${entry.identity}\n${occurrence}`;
    if (!this.rowIds.has(key)) this.rowIds.set(key, `r${this.nextId++}`);
    const id = this.rowIds.get(key)!;
    const text = entry.lines.join("\n");
    const seen = this.lastSeen.get(id);
    const times = seen === undefined ? { text, writtenAt: FILE_TIME, changedAt: FILE_TIME } : seen.text === text ? seen : { text, writtenAt: seen.writtenAt, changedAt: this.freshTime() };
    this.lastSeen.set(id, times);
    return { id, sectionId: this.sectionId(entry.section), kind: entry.kind, ...rowFieldsOf(entry), writtenDateIsEstimate: false, position: 0, writtenAt: times.writtenAt, writtenBy: "fixture", changedAt: times.changedAt, changedBy: "fixture", archivedAt: null, archivedBy: null };
  }

  private liveRows(): { entry: MarkdownEntry; row: StoredRow }[] {
    const occurrences = new Map<string, number>();
    return readMarkdownEntries(this.markdown).map((entry) => {
      const key = `${entry.section}\n${entry.identity}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      return { entry, row: this.rowOf(entry, occurrence) };
    });
  }

  storedPage(): StoredPage {
    const archivedRowCounts: Record<string, number> = {};
    for (const row of this.archivedRows) archivedRowCounts[row.sectionId] = (archivedRowCounts[row.sectionId] ?? 0) + 1;
    return { now: new Date().toISOString(), listing: { tabs: this.tabs(), sections: this.sections(), listingToken: LISTING_TOKEN }, rows: this.liveRows().map(({ row }) => row), archivedRowCounts };
  }

  private withoutLines(start: number, end: number): string {
    const lines = this.markdown.split("\n");
    const blankAfter = lines[end]?.trim() === "" ? 1 : 0;
    lines.splice(start, end - start + blankAfter);
    return lines.join("\n");
  }

  private withEpicAdded(lines: readonly string[]): string {
    const epicsHeading = `## ${EPICS}`;
    const markdown = this.markdown.includes(epicsHeading) ? this.markdown : `${this.markdown}\n${epicsHeading}\n`;
    return markdown.replace(`${epicsHeading}\n`, `${epicsHeading}\n\n${lines.join("\n")}\n`);
  }

  private write(address: string, method: string, body: Record<string, unknown>): Response {
    const live = this.liveRows();
    const rowId = /rows\/(r\d+)/.exec(address)?.[1];
    const found = live.find(({ row }) => row.id === rowId);
    if (method === "PUT") {
      if (found === undefined) return writeAnswer("refused", `There is no row ${rowId}.`);
      if (body.loadedChangedAt !== found.row.changedAt) return writeAnswer("refused", EPIC_CHANGED_WORDS, found.row);
      const freeLines = (body.row as { freeLines: string[] }).freeLines;
      const lines = this.markdown.split("\n");
      lines.splice(found.entry.start, found.entry.end - found.entry.start, found.entry.lines[0], ...freeLines);
      this.markdown = lines.join("\n");
      return writeAnswer("done", `Saved ${rowId}.`, this.liveRows().find(({ row }) => row.id === rowId)?.row);
    }
    if (address.endsWith("/archive")) {
      if (found === undefined) return writeAnswer("refused", `There is no row ${rowId}.`);
      if (body.loadedChangedAt !== undefined && body.loadedChangedAt !== found.row.changedAt) return writeAnswer("refused", `Not archived: row ${rowId} changed since it was loaded.`, found.row);
      this.markdown = this.withoutLines(found.entry.start, found.entry.end);
      this.archivedRows.unshift({ ...found.row, archivedAt: this.freshTime(), archivedBy: "Lord" });
      return writeAnswer("done", `Archived ${rowId}.`);
    }
    if (address.endsWith("/restore")) {
      const archived = this.archivedRows.findIndex(({ id }) => id === rowId);
      if (archived === -1) return writeAnswer("refused", `There is no archived row ${rowId}.`);
      const [row] = this.archivedRows.splice(archived, 1);
      if (row.kind === "epic") this.markdown = this.withEpicAdded([`### ${row.text}`, ...row.freeLines]);
      return writeAnswer("done", `Restored ${rowId}.`);
    }
    const added = body.row as { text: string; freeLines: string[] };
    this.markdown = this.withEpicAdded([`### ${added.text}`, ...(added.freeLines.length === 0 ? [] : ["", ...added.freeLines])]);
    return writeAnswer("done", "Added.");
  }

  private async answerPageRead(): Promise<Response> {
    const pageWhenAsked = this.storedPage();
    if (this.holdPageReads) await new Promise<void>((release) => this.heldPageReads.push({ release }));
    if (this.pageIsUnreadable) return Response.json({ outcome: "failed", message: "gone" }, { status: 500 });
    return Response.json(pageWhenAsked);
  }

  private async answerRecordsRead(): Promise<Response> {
    if (this.holdRecordsReads) await new Promise<void>((release) => this.heldRecordsReads.push({ release }));
    return this.recordsAnswer?.clone() ?? Response.json({ records: this.records, lastModified: FILE_TIME });
  }

  private async route(address: string, options?: RequestInit): Promise<Response> {
    const method = options?.method ?? "GET";
    if (method !== "GET") {
      const body = { ...(JSON.parse(String(options?.body)) as Record<string, unknown>), address, method };
      this.saveBodies.push(body);
      return this.answerToNextSaves === null ? this.write(address, method, body) : this.answerToNextSaves(body);
    }
    if (address.endsWith("/health")) return Response.json({ ok: true });
    if (address.endsWith("/where-i-stand/store/page")) return this.answerPageRead();
    const archivedOf = /sections\/(s\d+)\/archived-rows$/.exec(address)?.[1];
    if (archivedOf !== undefined) return Response.json({ rows: this.archivedRows.filter(({ sectionId }) => sectionId === archivedOf) });
    return this.answerRecordsRead();
  }

  readonly answer = async (address: string, options?: RequestInit): Promise<Response> => {
    this.addresses.push(address);
    if (this.networkIsDown) throw new TypeError("Failed to fetch");
    this.answersOnTheirWay += 1;
    try {
      return await this.route(address, options);
    } finally {
      this.answersOnTheirWay -= 1;
    }
  };

  holdNextSaves(): () => void {
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => (release = resolve));
    this.answerToNextSaves = async (body) => {
      await released;
      return this.write(body.address, body.method, body);
    };
    return () => release();
  }

  apiAddresses(): string[] {
    return this.addresses.filter((address) => !address.startsWith(API_PATH));
  }
}

function firstTextOf(element: Element): string {
  return element.childNodes[0]?.textContent ?? "";
}

export class OpenedPage {
  readonly user: UserEvent;
  readonly scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

  constructor(readonly backend: FakeBackend) {
    this.user = userEvent.setup();
  }

  tabs(): HTMLElement[] {
    return screen.getAllByRole("tab");
  }

  tab(words: string): HTMLElement {
    const tab = this.tabs().find((candidate) => firstTextOf(candidate) === words);
    if (tab === undefined) throw new Error(`the bar has no ${words} tab`);
    return tab;
  }

  selectedTabs(): string[] {
    return this.tabs()
      .filter((tab) => tab.getAttribute("aria-selected") === "true")
      .map(firstTextOf);
  }

  panel(): HTMLElement {
    return screen.getByRole("tabpanel");
  }

  headings(level: number): string[] {
    return within(this.panel())
      .queryAllByRole("heading", { level })
      .map((heading) => heading.textContent);
  }

  spoilers(): HTMLDetailsElement[] {
    return [...this.panel().querySelectorAll("details")];
  }

  summaries(): string[] {
    return this.spoilers().map((spoiler) => spoiler.querySelector("summary")?.textContent ?? "");
  }

  async chooseTab(words: string): Promise<void> {
    await this.user.click(this.tab(words));
    await waitFor(() => expect(this.selectedTabs()).toEqual([words]));
  }

  pressOnTabBar(key: string, timeStamp: number, modifiers: { altKey?: boolean; ctrlKey?: boolean } = {}): boolean {
    const list = screen.getByRole("tablist");
    const event = createEvent.keyDown(list, { key, ...modifiers });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    fireEvent(list, event);
    return event.defaultPrevented;
  }

  async settle(): Promise<void> {
    await waitFor(() => expect(this.backend.answersOnTheirWay).toBe(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve));
    });
  }

  async refresh(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await this.settle();
  }

  async goOffline(): Promise<void> {
    this.backend.networkIsDown = true;
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
  }

  async comeBackOnline(): Promise<void> {
    this.backend.networkIsDown = false;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await this.settle();
  }

  async refreshWith(markdown: string): Promise<void> {
    this.backend.markdown = markdown;
    await this.refresh();
  }

  private async moveInHistory(steps: number): Promise<void> {
    await act(async () => {
      window.history.go(steps);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async goBack(): Promise<void> {
    await this.moveInHistory(-1);
  }

  async goForward(): Promise<void> {
    await this.moveInHistory(1);
  }
}

export function watchAnnouncements(): string[] {
  const region = document.querySelector(".visually-hidden") as Element;
  const announced: string[] = [];
  const watcher = new MutationObserver((writes) => announced.push(...writes.map(() => region.textContent)));
  watcher.observe(region, { childList: true, characterData: true, subtree: true });
  return announced;
}

export function editButton(title: string): HTMLElement {
  return screen.getByRole("button", { name: `Edit ${title} epic` });
}

export function startOpeningPage(backend = new FakeBackend(), hash = "", path = PAGE_PATH): OpenedPage {
  cleanup();
  window.history.pushState({}, "", `${path}${hash}`);
  vi.stubGlobal("fetch", vi.fn(backend.answer));
  const page = new OpenedPage(backend);
  render(<App />);
  return page;
}

export async function openPage(backend = new FakeBackend(), hash = "", path = PAGE_PATH): Promise<OpenedPage> {
  const page = startOpeningPage(backend, hash, path);
  await page.settle();
  return page;
}
