import type { PullRequestRecords, SaveRequest } from "@contract/where-i-stand.ts";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { App } from "@/app/app";
import { entryMeantHasChanged, removalLeavesLinesBehind, replaceUnitLines, unitIsRepeated } from "../../../../src/where-i-stand/page-save.ts";

const PAGE_PATH = "/throne/where-i-stand/";
const API_PATH = "/throne/api/";
const EPICS_HEADING_LINE = "## Epics";
const FILE_TIME = "2026-11-05T04:00:00.000Z";

export const ENTRY_REPEATED_WORDS = "Not saved: this entry's text is on the page more than once, so the save cannot tell which one you mean, and nothing was overwritten.";

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

function saveAnswer(outcome: string, message: string, status: number): Response {
  return Response.json({ outcome, message }, { status });
}

export class FakeBackend {
  markdown: string;
  records: unknown;
  recordsAnswer: Response | null = null;
  pageIsUnreadable = false;
  networkIsDown = false;
  answerToNextSaves: ((body: SaveRequest) => Promise<Response> | Response) | null = null;
  holdPageReads = false;
  readonly heldPageReads: HeldAnswer[] = [];
  holdRecordsReads = false;
  readonly heldRecordsReads: HeldAnswer[] = [];
  readonly saveBodies: SaveRequest[] = [];
  readonly addresses: string[] = [];
  answersOnTheirWay = 0;

  constructor(markdown = SAMPLE_MARKDOWN, records: unknown = SAMPLE_RECORDS) {
    this.markdown = markdown;
    this.records = records;
  }

  private saveToThePage(change: SaveRequest): Response {
    const { loaded } = change;
    if (loaded === EPICS_HEADING_LINE && !this.markdown.includes(EPICS_HEADING_LINE)) this.markdown = `${this.markdown}\n${EPICS_HEADING_LINE}\n`;
    if (unitIsRepeated(this.markdown, change)) return saveAnswer("entry-repeated", ENTRY_REPEATED_WORDS, 409);
    const saved = replaceUnitLines(this.markdown, change);
    if (saved === undefined || removalLeavesLinesBehind(this.markdown, change) || entryMeantHasChanged(this.markdown, change)) return saveAnswer("entry-changed", "Not saved: this entry changed since the page loaded, and nothing was overwritten.", 409);
    this.markdown = saved;
    return saveAnswer("saved", "Saved.", 200);
  }

  private async answerPageRead(): Promise<Response> {
    const markdownWhenAsked = this.markdown;
    if (this.holdPageReads) await new Promise<void>((release) => this.heldPageReads.push({ release }));
    if (this.pageIsUnreadable) return Response.json({ outcome: "failed", message: "gone" }, { status: 500 });
    return Response.json({ markdown: markdownWhenAsked, lastModified: FILE_TIME });
  }

  private async answerRecordsRead(): Promise<Response> {
    if (this.holdRecordsReads) await new Promise<void>((release) => this.heldRecordsReads.push({ release }));
    return this.recordsAnswer?.clone() ?? Response.json({ records: this.records, lastModified: FILE_TIME });
  }

  private async route(address: string, options?: RequestInit): Promise<Response> {
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body)) as SaveRequest;
      this.saveBodies.push(body);
      return this.answerToNextSaves === null ? this.saveToThePage(body) : this.answerToNextSaves(body);
    }
    if (address.endsWith("/health")) return Response.json({ ok: true });
    if (address.endsWith("/where-i-stand/page")) return this.answerPageRead();
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
      return this.saveToThePage(body);
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
