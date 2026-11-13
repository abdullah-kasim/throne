import type { StoredRow, StoredSection, StoredTab } from "@contract/where-i-stand.ts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "@/app/app";
import { recordsWith } from "@/features/where-i-stand/where-i-stand.test-support";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 10, 12, 23, 0).getTime();

function ago(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

function authorship(writtenAgo: number, changedAgo = writtenAgo) {
  return { writtenAt: ago(writtenAgo), writtenBy: "alpha", changedAt: ago(changedAgo), changedBy: "alpha", archivedAt: null, archivedBy: null };
}

function tab(id: string, name: string, position: number): StoredTab {
  return { id, name, position, ...authorship(30 * DAY) };
}

function section(id: string, tabId: string, name: string, position: number, parentId: string | null = null): StoredSection {
  return { id, tabId, parentId, name, position, ...authorship(30 * DAY) };
}

function workRow(id: string, sectionId: string, code: string, writtenAgo: number, changedAgo = writtenAgo): StoredRow {
  return {
    id,
    sectionId,
    kind: "work",
    code,
    links: `no pull request · branch ${code} · Ticket no ticket`,
    workKind: `new page — ${code} work`,
    whereItStands: "building",
    freeLines: [],
    text: "",
    writtenDateIsEstimate: false,
    position: 0,
    ...authorship(writtenAgo, changedAgo),
  };
}

function eventRow(id: string, sectionId: string, text: string, writtenAgo: number): StoredRow {
  return { ...workRow(id, sectionId, "", writtenAgo), kind: "event", code: null, links: null, workKind: null, whereItStands: null, text };
}

class StoreFake {
  tabs = [tab("t1", "Now", 0), tab("t2", "Epics", 1), tab("t3", "Queue", 2)];
  sections = [section("s1", "t1", "Needs you", 0), section("s2", "t1", "Just happened", 1), section("s3", "t1", "In flight", 2), section("s4", "t2", "Epics", 0), section("s5", "t3", "Queued and deferred", 0)];
  rows: StoredRow[] = [
    workRow("r1", "s3", "alpha-oven", 5 * MINUTE),
    workRow("r2", "s3", "alpha-crown", 3 * DAY),
    eventRow("r3", "s2", "delivered menu: the menu skill sorts", 20 * MINUTE),
    { ...workRow("r4", "s3", "alpha-sign", 20 * DAY), archivedAt: ago(6 * DAY), archivedBy: "alpha" },
    { ...workRow("r5", "s3", "alpha-bell", 40 * DAY), archivedAt: ago(2 * DAY), archivedBy: "alpha" },
  ];
  serverAhead = 0;
  readonly addresses: string[] = [];
  readonly writes: { address: string; body: unknown }[] = [];

  private liveSectionIds(): Set<string> {
    return new Set(this.sections.filter(({ archivedAt }) => archivedAt === null).map(({ id }) => id));
  }

  private page() {
    const archivedRowCounts: Record<string, number> = {};
    for (const row of this.rows.filter(({ archivedAt }) => archivedAt !== null)) archivedRowCounts[row.sectionId] = (archivedRowCounts[row.sectionId] ?? 0) + 1;
    const live = this.liveSectionIds();
    return {
      now: new Date(Date.now() + this.serverAhead).toISOString(),
      listing: { tabs: this.tabs, sections: this.sections, listingToken: "token" },
      rows: this.rows.filter((row) => row.archivedAt === null && live.has(row.sectionId)),
      archivedRowCounts,
    };
  }

  private archiveOrRestore(kind: "rows" | "sections", id: string, isArchive: boolean): Response {
    const items: (StoredRow | StoredSection)[] = kind === "rows" ? this.rows : this.sections;
    const item = items.find((each) => each.id === id);
    if (item === undefined) return Response.json({ outcome: "refused", message: `There is no ${id}.` });
    Object.assign(item, isArchive ? { archivedAt: new Date(Date.now()).toISOString(), archivedBy: "Lord" } : { archivedAt: null, archivedBy: null });
    return Response.json({ outcome: "done", message: "done" });
  }

  readonly answer = async (address: string, options?: RequestInit): Promise<Response> => {
    this.addresses.push(address);
    const write = /store\/(rows|sections)\/([rs]\d+)\/(archive|restore)$/.exec(address);
    if (options?.method === "POST" && write !== null) {
      this.writes.push({ address, body: JSON.parse(String(options.body)) });
      return this.archiveOrRestore(write[1] as "rows" | "sections", write[2], write[3] === "archive");
    }
    if (address.endsWith("/health")) return Response.json({ ok: true });
    if (address.endsWith("/store/page")) return Response.json(this.page());
    const archivedOf = /sections\/(s\d+)\/archived-rows$/.exec(address)?.[1];
    if (archivedOf !== undefined) return Response.json({ rows: this.rows.filter((row) => row.sectionId === archivedOf && row.archivedAt !== null) });
    return Response.json({ records: recordsWith(), lastModified: new Date(NOW).toISOString() });
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

async function openStorePage(store = new StoreFake(), hash = "#now") {
  cleanup();
  window.history.pushState({}, "", `/throne/where-i-stand/${hash}`);
  vi.stubGlobal("fetch", vi.fn(store.answer));
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  render(<App />);
  await screen.findByRole("tab", { selected: true });
  await settle();
  return { store, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) };
}

function sectionNamed(name: string): HTMLElement {
  return screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;
}

function ageButtons(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".row-age button")].map(({ textContent }) => textContent ?? "");
}

async function refresh() {
  await act(async () => {
    window.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
  });
}

test("B3.1 the tabs and the sections of each tab come from the stored page", async () => {
  await openStorePage();

  expect(screen.getAllByRole("tab").map((each) => each.childNodes[0].textContent)).toEqual(["Now", "Epics", "Queue", "Archive"]);
  expect(within(screen.getByRole("tabpanel")).getAllByRole("heading", { level: 2 }).map(({ textContent }) => textContent)).toEqual(["Needs you", "Just happened", "In flight"]);
});

test("B3.2 a tab and a section created in the store appear on the page after a refresh, and stay after a reload", async () => {
  const { store, user } = await openStorePage();
  store.tabs.push(tab("t9", "Ideas", 3));
  store.sections.push(section("s9", "t9", "Parked ideas", 0));
  store.rows.push(workRow("r9", "s9", "alpha-kiosk", 2 * HOUR));

  await refresh();
  await user.click(screen.getByRole("tab", { name: /^Ideas/ }));

  expect(window.location.hash).toBe("#ideas");
  expect(sectionNamed("Parked ideas").textContent).toContain("alpha-kiosk");
  await openStorePage(store, "#ideas");
  expect(screen.getByRole("tab", { selected: true }).childNodes[0].textContent).toBe("Ideas");
});

test("B3.3 a subsection is shown nested under its section and holds rows", async () => {
  const store = new StoreFake();
  store.sections.push(section("s6", "t1", "Oven work", 0, "s3"));
  store.rows.push(workRow("r6", "s6", "alpha-thermostat", 3 * DAY));
  await openStorePage(store);

  const subsection = screen.getByRole("heading", { level: 3, name: "Oven work" }).closest("section") as HTMLElement;
  expect(subsection.parentElement).toBe(sectionNamed("In flight"));
  expect(within(subsection).getByRole("heading", { level: 4, name: "alpha-thermostat" })).toBeTruthy();
});

test("B1.2 B2.5 archived rows wait in a collapsed spoiler labelled with their count and are fetched only when it opens", async () => {
  const { store, user } = await openStorePage();
  const spoiler = within(sectionNamed("In flight")).getByRole("button", { name: "Archived (2)" });

  expect(spoiler.getAttribute("aria-expanded")).toBe("false");
  expect(store.addresses.filter((address) => /archived-rows|journal/.test(address))).toEqual([]);
  expect(sectionNamed("In flight").textContent).not.toContain("alpha-sign");

  await user.click(spoiler);
  await settle();

  expect(store.addresses.filter((address) => /archived-rows/.test(address))).toEqual(["/throne/api/where-i-stand/store/sections/s3/archived-rows"]);
  expect(store.addresses.filter((address) => /journal/.test(address))).toEqual([]);
  expect(sectionNamed("In flight").textContent).toContain("alpha-sign");
});

test("B5.5 an archived row shows when it was archived and the month it will be deleted", async () => {
  const { user } = await openStorePage();

  await user.click(screen.getByRole("button", { name: "Archived (2)" }));
  await settle();

  const deletionMonth = new Date(2027, 4, 6).toLocaleString(undefined, { month: "long", year: "numeric" });
  expect(ageButtons(sectionNamed("In flight"))).toContain(`archived 6 days ago, deleted in ${deletionMonth}`);
});

test("B1.3 restoring an archived row from the spoiler puts it back among the live rows, and a reload keeps it there", async () => {
  const { store, user } = await openStorePage();
  await user.click(screen.getByRole("button", { name: "Archived (2)" }));
  await settle();

  await user.click(screen.getByRole("button", { name: "Restore alpha-sign" }));
  await settle();

  expect(store.writes).toEqual([{ address: "/throne/api/where-i-stand/store/rows/r4/restore", body: { writer: "Lord" } }]);
  expect(within(sectionNamed("In flight")).getByRole("button", { name: "Archived (1)" })).toBeTruthy();
  await openStorePage(store);
  expect(within(sectionNamed("In flight")).getByRole("heading", { level: 3, name: "alpha-sign" })).toBeTruthy();
});

test("restoring a row by keyboard leaves focus on the spoiler, not on the page body", async () => {
  const { user } = await openStorePage();
  await user.click(screen.getByRole("button", { name: "Archived (2)" }));
  await settle();

  screen.getByRole("button", { name: "Restore alpha-sign" }).focus();
  await user.keyboard("{Enter}");
  await settle();

  expect(document.activeElement).toBe(within(sectionNamed("In flight")).getByRole("button", { name: "Archived (1)" }));
});

test("B1.4 the Lord archives a row through the archive question and it moves into its section's spoiler", async () => {
  const { store, user } = await openStorePage();

  await user.click(screen.getByRole("button", { name: "Archive alpha-oven" }));
  const question = await screen.findByRole("alertdialog");
  expect(within(question).getByRole("heading").textContent).toBe("Archive 'alpha-oven'?");
  await user.click(within(question).getByRole("button", { name: "Archive" }));
  await settle();

  expect(store.writes).toEqual([{ address: "/throne/api/where-i-stand/store/rows/r1/archive", body: { writer: "Lord" } }]);
  expect(within(sectionNamed("In flight")).queryByRole("heading", { level: 3, name: "alpha-oven" })).toBeNull();
  expect(within(sectionNamed("In flight")).getByRole("button", { name: "Archived (3)" })).toBeTruthy();
  await openStorePage(store);
  expect(within(sectionNamed("In flight")).queryByRole("heading", { level: 3, name: "alpha-oven" })).toBeNull();
});

test("B1.4 keeping the row at the archive question archives nothing", async () => {
  const { store, user } = await openStorePage();

  await user.click(screen.getByRole("button", { name: "Archive alpha-oven" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep it" }));
  await settle();

  expect(store.writes).toEqual([]);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Archive alpha-oven" }));
});

test("B1.5 an archived section leaves the tab for its spoiler and comes back with the rows that were live", async () => {
  const { store, user } = await openStorePage();

  await user.click(screen.getByRole("button", { name: "Archive section In flight" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive" }));
  await settle();

  expect(screen.queryByRole("heading", { level: 2, name: "In flight" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Archived sections (1)" }));
  await user.click(screen.getByRole("button", { name: "Restore In flight" }));
  await settle();

  expect(store.writes.map(({ address }) => address)).toEqual(["/throne/api/where-i-stand/store/sections/s3/archive", "/throne/api/where-i-stand/store/sections/s3/restore"]);
  expect(within(sectionNamed("In flight")).getAllByRole("heading", { level: 3 }).map(({ textContent }) => textContent)).toEqual(["alpha-oven", "alpha-crown"]);
});

test("B5.1 every row shows its age in words", async () => {
  const store = new StoreFake();
  store.rows = [
    workRow("r1", "s3", "alpha-a", 10000),
    workRow("r2", "s3", "alpha-b", 5 * MINUTE),
    workRow("r3", "s3", "alpha-c", 3 * HOUR),
    workRow("r4", "s3", "alpha-d", 14 * HOUR),
    workRow("r5", "s3", "alpha-e", 26 * HOUR),
    workRow("r6", "s3", "alpha-f", 4 * DAY),
    workRow("r7", "s3", "alpha-g", 15 * DAY),
    workRow("r8", "s3", "alpha-h", 70 * DAY),
  ];
  await openStorePage(store);

  expect(ageButtons(sectionNamed("In flight"))).toEqual([
    "written just now",
    "written 5 minutes ago",
    "written 3 hours ago",
    "written today",
    "written yesterday",
    "written 4 days ago",
    "written 2 weeks ago",
    "written 2 months ago",
  ]);
});

test("B5.1 ages are measured from the server's clock, not the browser's", async () => {
  const store = new StoreFake();
  store.rows = [workRow("r1", "s3", "alpha-a", 5 * MINUTE)];
  store.serverAhead = 3 * HOUR;
  await openStorePage(store);

  expect(ageButtons(sectionNamed("In flight"))).toEqual(["written 3 hours ago"]);
});

test("B5.2 the exact date and time are on hover, on tap and in the accessible name", async () => {
  const { user } = await openStorePage();
  const exact = new Date(NOW - 5 * MINUTE).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const age = screen.getByRole("button", { name: `written 5 minutes ago (written ${exact})` });

  expect(age.getAttribute("title")).toBe(`written ${exact}`);
  await user.click(age);
  expect(age.closest(".row-age")?.textContent).toContain(`written ${exact}`);
});

test("B5.3 a row changed after it was written shows both", async () => {
  const store = new StoreFake();
  store.rows = [workRow("r1", "s3", "alpha-oven", 5 * DAY, 2 * HOUR)];
  await openStorePage(store);

  expect(ageButtons(sectionNamed("In flight"))).toEqual(["written 5 days ago, changed 2 hours ago"]);
});

test("B5.4 event lines show their time", async () => {
  await openStorePage();

  expect(ageButtons(sectionNamed("Just happened"))).toEqual(["written 20 minutes ago"]);
});

test("B5.6 a section with rows from several days shows Today, Yesterday, Earlier this week and Older, each only when it has rows", async () => {
  const store = new StoreFake();
  store.rows = [workRow("r1", "s3", "alpha-a", 2 * HOUR), workRow("r2", "s3", "alpha-b", 3 * DAY), workRow("r3", "s3", "alpha-c", 20 * DAY), workRow("r4", "s5", "alpha-d", HOUR)];
  await openStorePage(store);

  const dividers = (name: string) => [...sectionNamed(name).querySelectorAll(".age-divider")].map(({ textContent }) => textContent);
  expect(dividers("In flight")).toEqual(["Today", "Earlier this week", "Older"]);
  expect(dividers("Just happened")).toEqual([]);
});

test("B7.4 a section whose stored order is not newest first keeps that order and shows no dividers", async () => {
  const store = new StoreFake();
  store.rows = [workRow("r1", "s3", "alpha-receipts", 9 * DAY), workRow("r2", "s3", "alpha-checkout", 6 * HOUR)];
  await openStorePage(store);

  expect([...sectionNamed("In flight").querySelectorAll("h3, h4")].map(({ textContent }) => textContent)).toEqual(["alpha-receipts", "alpha-checkout"]);
  expect(sectionNamed("In flight").querySelectorAll(".age-divider")).toHaveLength(0);
});

test("B5.7 ages advance while the page stays open", async () => {
  await openStorePage();
  expect(ageButtons(sectionNamed("In flight"))[0]).toBe("written 5 minutes ago");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
  });

  expect(ageButtons(sectionNamed("In flight"))[0]).toBe("written 7 minutes ago");
});
