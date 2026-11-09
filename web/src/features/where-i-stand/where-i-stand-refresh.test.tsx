import { onlineManager } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FakeBackend, openPage, SAMPLE_MARKDOWN, SAMPLE_RECORDS } from "@/features/where-i-stand/where-i-stand.test-support";

const PULL_REQUESTS_HASH = "#pull-requests";
const REFRESH_INTERVAL_MILLISECONDS = 60000;
const pageReads = (backend: FakeBackend) => backend.addresses.filter((address) => address.endsWith("/page")).length;
const recordsReads = (backend: FakeBackend) => backend.addresses.filter((address) => address.endsWith("/records")).length;

function watchStatusRegions(): string[] {
  const announced: string[] = [];
  const watcher = new MutationObserver((writes) => announced.push(...writes.map(({ target }) => target.textContent ?? "")));
  screen.getAllByRole("status").forEach((region) => watcher.observe(region, { childList: true, characterData: true, subtree: true }));
  return announced;
}

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

test("the page refreshes every sixty seconds", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const backend = new FakeBackend();
  await openPage(backend);
  expect(pageReads(backend)).toBe(1);

  await act(() => vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MILLISECONDS));

  expect(pageReads(backend)).toBe(2);
  expect(recordsReads(backend)).toBe(2);
});

test("the page refreshes when it becomes visible", async () => {
  const backend = new FakeBackend();
  const page = await openPage(backend);

  await page.refresh();

  expect(pageReads(backend)).toBe(2);
  expect(recordsReads(backend)).toBe(2);
});

test("the page says when the file was last modified", async () => {
  await openPage();

  expect(screen.getByText(/^File last modified /)).toBeTruthy();
});

test("the page says what could not be fetched when nothing has been fetched yet", async () => {
  const backend = new FakeBackend();
  backend.pageIsUnreadable = true;

  await openPage(backend);

  expect(screen.getByText(/^Could not fetch the file at .+\. Nothing has been fetched yet\.$/)).toBeTruthy();
});

test("the page keeps what it showed and says so when a refresh cannot fetch the file", async () => {
  const backend = new FakeBackend();
  const page = await openPage(backend);
  backend.pageIsUnreadable = true;

  await page.refresh();

  expect(screen.getByText(/^Could not fetch the file at .+\. Showing what was last fetched\.$/)).toBeTruthy();
  expect(page.headings(2)).toEqual(["Needs you", "Just happened", "In flight"]);

  backend.pageIsUnreadable = false;
  await page.refresh();
  expect(screen.queryByText(/^Could not fetch the file/)).toBeNull();
});

test("offline, a read says it could not fetch and keeps what was last fetched", async () => {
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  await page.goOffline();

  await page.refresh();

  expect(screen.getByText(/^Could not fetch the file at .+\. Showing what was last fetched\.$/)).toBeTruthy();
  expect(page.panel().textContent).toMatch(/Could not fetch the pull request records at .+\. Showing what was last fetched\./);
  expect(page.panel().querySelector(".work tbody")?.textContent).toContain("Add a gift card page");
  expect(page.headings(2)).toEqual(["Your work", "On GitHub"]);
});

test("coming back online clears what the failed reads said without waiting for the next refresh", async () => {
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  await page.goOffline();
  await page.refresh();

  await page.comeBackOnline();

  await waitFor(() => expect(screen.queryByText(/^Could not fetch the file/)).toBeNull());
  await waitFor(() => expect(page.panel().textContent).not.toMatch(/Could not fetch the pull request records/));
});

test("a read that keeps failing is announced once, and its recovery once", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  const announced = watchStatusRegions();
  await page.goOffline();

  await act(() => vi.advanceTimersByTimeAsync(3 * REFRESH_INTERVAL_MILLISECONDS));
  await page.comeBackOnline();
  await act(() => vi.advanceTimersByTimeAsync(2 * REFRESH_INTERVAL_MILLISECONDS));

  const pageAndRecordsWords = announced.filter((words) => !words.includes("backend"));
  expect(pageAndRecordsWords.toSorted()).toEqual(["Could not fetch the file. Showing what was last fetched.", "Could not fetch the pull request records. Showing what was last fetched.", "The file was fetched again.", "The pull request records were fetched again."]);
});

test("a read that has never answered is announced once, however often it is asked again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const backend = new FakeBackend();
  backend.pageIsUnreadable = true;
  backend.recordsAnswer = new Response("missing", { status: 404 });
  const page = await openPage(backend);
  const announced = watchStatusRegions();
  backend.holdPageReads = true;
  backend.holdRecordsReads = true;

  await act(() => vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MILLISECONDS));
  expect(backend.heldPageReads).toHaveLength(1);
  expect(backend.heldRecordsReads).toHaveLength(1);
  [...backend.heldPageReads, ...backend.heldRecordsReads].forEach(({ release }) => release());
  await page.settle();

  const regionWords = screen.getAllByRole("status").map(({ textContent }) => textContent);
  expect(regionWords).toContain("Could not fetch the file. Nothing has been fetched yet.");
  expect(regionWords).toContain("Could not fetch the pull request records.");
  expect(announced).toEqual([]);
});

test("a page that reads without trouble announces nothing", async () => {
  const page = await openPage();

  await page.refresh();

  expect(screen.getAllByRole("status").map(({ textContent }) => textContent)).toEqual(["The backend answered", "", "", "", ""]);
});

test("the where-i-stand page still shows the entries' rows and the agents' sections when the pull request records cannot be fetched", async () => {
  for (const unreadableRecords of [new Response("missing", { status: 404 }), new Response("{ not json"), Response.json({ records: {}, lastModified: "soon" })]) {
    const backend = new FakeBackend();
    backend.recordsAnswer = unreadableRecords;

    const page = await openPage(backend, PULL_REQUESTS_HASH);

    expect(page.panel().textContent).toMatch(/Could not fetch the pull request records at /);
    expect(page.panel().querySelector(".work tbody")?.textContent).toContain("Keep the oven warm");
    expect(page.headings(2)).toEqual(["Your work", "On GitHub"]);
  }
});

test("the where-i-stand page keeps the pull request records it last fetched when the records can no longer be fetched", async () => {
  const backend = new FakeBackend();
  const page = await openPage(backend, PULL_REQUESTS_HASH);
  backend.recordsAnswer = new Response("missing", { status: 404 });

  await page.refresh();

  expect(page.panel().textContent).toMatch(/Could not fetch the pull request records at .+\. Showing what was last fetched\. Pull requests read .+, just now\./);
  expect(page.panel().querySelector(".work tbody")?.textContent).toContain("Add a gift card page");
});

test("a late answer to an earlier refresh does not replace what a later refresh of the where-i-stand page showed", async () => {
  const backend = new FakeBackend();
  const page = await openPage(backend, "#epics");
  backend.holdPageReads = true;
  await act(async () => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(backend.heldPageReads).toHaveLength(1));
  backend.holdPageReads = false;

  await page.user.click(screen.getByRole("button", { name: "Edit Open a second bakery epic" }));
  await page.user.type(screen.getByRole("textbox", { name: "Open a second bakery epic" }), " today");
  await page.user.click(screen.getByRole("button", { name: "Save Open a second bakery epic" }));
  await waitFor(() => expect(backend.saveBodies).toHaveLength(1));
  await waitFor(() => expect(pageReads(backend)).toBe(3));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Open a second bakery epic" }).value).toMatch(/today$/));
  backend.heldPageReads.forEach(({ release }) => release());
  await page.settle();

  expect(backend.markdown).toContain("morning foot traffic. today");
  await page.user.click(screen.getByRole("button", { name: "Close Open a second bakery epic" }));
  expect(page.panel().textContent).toContain("morning foot traffic. today");
});

test("an age on the page moves on at each refresh even when nothing else changed", async () => {
  const backend = new FakeBackend(SAMPLE_MARKDOWN, { ...SAMPLE_RECORDS, read_at: new Date(Date.now() - 90000).toISOString() });
  const page = await openPage(backend, PULL_REQUESTS_HASH);
  expect(page.panel().textContent).toMatch(/, 2 minutes ago\./);

  backend.markdown = SAMPLE_MARKDOWN;
  vi.spyOn(Date, "now").mockImplementation(() => new Date().getTime() + 120000);
  await page.refresh();
  vi.restoreAllMocks();

  expect(page.panel().textContent).toMatch(/, 4 minutes ago\./);
});
