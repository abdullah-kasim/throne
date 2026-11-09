import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BAKERY, COOKBOOK, editButton, EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, watchAnnouncements, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const APP_PATH = "/throne/";
const NO_PAGE_PATH = "/throne/nothing-here";
const PAGE_TITLE = "Where I stand";
const SAVING_WORDS = "Saving.";
const SAVED_WORDS = "Saved.";
const BACKEND_UNREACHABLE_WORDS = "Not saved: the backend could not be reached.";
const REFRESH_INTERVAL_MILLISECONDS = 60000;
const LONGER_THAN_ANY_CACHE_KEEPS_UNUSED_DATA_MILLISECONDS = 3600000;
const MARKDOWN_WITH_NEW_WORDS = SAMPLE_MARKDOWN.replace("morning foot traffic", "evening foot traffic");

const titleBox = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Title" });
const notesBox = (title: string) => screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${title} epic` });
const shellLink = () => screen.getByRole("link", { name: PAGE_TITLE });
const announcementRegion = () => document.querySelector(".visually-hidden") as Element;
const readsSoFar = (backend: FakeBackend) => backend.addresses.filter((address) => !address.endsWith("/health")).length;

async function openThroughTheShell(backend = new FakeBackend()): Promise<OpenedPage> {
  document.title = "Throne";
  const page = await openPage(backend, "", APP_PATH);
  await page.user.click(screen.getByRole("link", { name: PAGE_TITLE }));
  await page.settle();
  return page;
}

async function openEpicsThroughTheShell(backend = new FakeBackend()): Promise<OpenedPage> {
  const page = await openThroughTheShell(backend);
  await page.chooseTab("Epics");
  return page;
}

async function leaveEpicsByTheRoute(page: OpenedPage) {
  await page.goBack();
  await page.goBack();
  await page.settle();
}

async function comeBackToEpics(page: OpenedPage) {
  await page.goForward();
  await page.goForward();
  await page.settle();
}

async function leaveWithTheRemovalQuestionOpen(): Promise<OpenedPage> {
  window.history.pushState({}, "", APP_PATH);
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(screen.getByRole("button", { name: `Remove ${BAKERY} epic` }));
  await screen.findByRole("alertdialog");
  await page.goBack();
  await page.settle();
  return page;
}

async function typeIntoEpic(page: OpenedPage, title: string, words: string) {
  await page.user.click(editButton(title));
  await page.user.type(notesBox(title), words);
}

async function pressSaveKey(page: OpenedPage) {
  await page.user.keyboard("{Control>}s{/Control}");
}

function holdNextSaveUntilItFails(backend: FakeBackend): () => void {
  let failTheSave = () => undefined as void;
  backend.answerToNextSaves = () => new Promise((_, refuse) => (failTheSave = () => refuse(new TypeError("Failed to fetch"))));
  return () => failTheSave();
}

async function answerWhileHidden(page: OpenedPage, answer: () => void) {
  await page.goBack();
  await page.goBack();
  await act(async () => {
    answer();
    await new Promise((resolve) => setTimeout(resolve));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

test("a page never opened starts no reads", async () => {
  const backend = new FakeBackend();

  await openPage(backend, "", APP_PATH);

  expect(readsSoFar(backend)).toBe(0);
  expect(document.querySelector(".where-i-stand")).toBeNull();
});

test("an address with no page starts no reads", async () => {
  const backend = new FakeBackend();

  await openPage(backend, "", "/throne/nothing-here");

  expect(readsSoFar(backend)).toBe(0);
  expect(screen.getByText("There is no page at this address.")).toBeTruthy();
});

test("text typed on the page survives leaving by the app's own route and coming back", async () => {
  const page = await openEpicsThroughTheShell();
  await page.user.type(titleBox(), "keepme");
  await page.user.click(editButton(BAKERY));
  await page.user.type(notesBox(BAKERY), "draftwords");

  await leaveEpicsByTheRoute(page);
  expect(window.location.pathname).toBe(APP_PATH);
  expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  await comeBackToEpics(page);

  expect(titleBox().value).toBe("keepme");
  expect(notesBox(BAKERY).value).toContain("draftwords");
});

test("words kept from a refused save survive leaving by the app's own route and coming back", async () => {
  const page = await openEpicsThroughTheShell();
  await page.user.click(editButton(BAKERY));
  await page.user.type(notesBox(BAKERY), "lostwords");
  page.backend.markdown = MARKDOWN_WITH_NEW_WORDS;
  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();

  await leaveEpicsByTheRoute(page);
  await comeBackToEpics(page);

  expect(page.panel().querySelector(".unsaved")?.textContent).toContain("lostwords");
});

test("coming back by the shell's link keeps what was typed for the Epics tab", async () => {
  const page = await openEpicsThroughTheShell();
  await page.user.type(titleBox(), "keepme");

  await leaveEpicsByTheRoute(page);
  await page.user.click(screen.getByRole("link", { name: PAGE_TITLE }));
  await page.settle();
  await page.chooseTab("Epics");

  expect(titleBox().value).toBe("keepme");
});

test("focus comes back on the selected tab, never on the body", async () => {
  const page = await openThroughTheShell();

  await page.goBack();
  await page.settle();
  screen.getByRole("link", { name: PAGE_TITLE }).blur();
  await page.goForward();
  await page.settle();

  expect(document.activeElement).toBe(page.tab("Now"));
});

test("going back out of the page puts focus on the shell link that opens it", async () => {
  const page = await openThroughTheShell();
  page.tab("Now").focus();

  await page.goBack();
  await page.settle();

  expect(document.activeElement).toBe(shellLink());
});

test("going back out of the page onto an address with no page puts focus on the shell link", async () => {
  const page = await openPage(new FakeBackend(), "", NO_PAGE_PATH);
  await page.user.click(shellLink());
  await page.settle();
  page.tab("Now").focus();

  await page.goBack();
  await page.settle();

  expect(window.location.pathname).toBe(NO_PAGE_PATH);
  expect(document.activeElement).toBe(shellLink());
});

test("going back out of the page leaves focus on the shell link when it was already there", async () => {
  const page = await openThroughTheShell();
  shellLink().focus();

  await page.goBack();
  await page.settle();

  expect(document.activeElement).toBe(shellLink());
});

test("going back out of the page after pressing plain text puts focus on the shell link", async () => {
  const page = await openThroughTheShell();
  await page.user.click(screen.getByRole("heading", { level: 1, name: PAGE_TITLE }));
  expect(document.activeElement).toBe(document.body);

  await page.goBack();
  await page.settle();

  expect(document.activeElement).toBe(shellLink());
});

test("going back out of the page with the removal question open puts focus on the shell link", async () => {
  const page = await leaveWithTheRemovalQuestionOpen();


  expect(window.location.pathname).toBe(APP_PATH);
  expect(document.activeElement).toBe(shellLink());
});

test("coming back through history puts focus on the selected tab, off the shell link", async () => {
  const page = await openEpicsThroughTheShell();
  page.tab("Epics").focus();

  await leaveEpicsByTheRoute(page);
  expect(document.activeElement).toBe(shellLink());
  await comeBackToEpics(page);

  expect(document.activeElement).toBe(page.tab("Epics"));
});

test("coming back by pressing the shell link keeps focus on that link", async () => {
  const page = await openThroughTheShell();
  page.tab("Now").focus();
  await page.goBack();
  await page.settle();

  await page.user.keyboard("{Enter}");
  await page.settle();

  expect(window.location.pathname).toBe("/throne/where-i-stand");
  expect(document.activeElement).toBe(shellLink());
});

test("a failed save answered while the page is hidden is spoken when the page comes back", async () => {
  const page = await openEpicsThroughTheShell();
  await typeIntoEpic(page, BAKERY, "draftwords");
  const failTheSave = holdNextSaveUntilItFails(page.backend);
  await pressSaveKey(page);
  const announced = watchAnnouncements();

  await answerWhileHidden(page, failTheSave);
  expect(announced).toEqual([]);
  await comeBackToEpics(page);

  expect(announced).toEqual([BACKEND_UNREACHABLE_WORDS]);
});

test("a Saved answer while the page is hidden leaves no saving words in the status region", async () => {
  const page = await openEpicsThroughTheShell();
  await typeIntoEpic(page, BAKERY, "draftwords");
  const releaseTheSave = page.backend.holdNextSaves();
  await pressSaveKey(page);
  expect(announcementRegion().textContent).toBe(SAVING_WORDS);

  await answerWhileHidden(page, releaseTheSave);
  await comeBackToEpics(page);

  expect(announcementRegion().textContent).toBe(SAVED_WORDS);
});

test("an answer spoken before the page hid is not spoken again on return", async () => {
  const page = await openEpicsThroughTheShell();
  await typeIntoEpic(page, BAKERY, "draftwords");
  await pressSaveKey(page);
  await page.settle();
  await waitFor(() => expect(announcementRegion().textContent).toBe(SAVED_WORDS));
  const announced = watchAnnouncements();

  await leaveEpicsByTheRoute(page);
  await comeBackToEpics(page);

  expect(announced).toEqual([]);
});

test("an answer spoken on return is not spoken again on the next return", async () => {
  const page = await openEpicsThroughTheShell();
  await typeIntoEpic(page, BAKERY, "draftwords");
  const failTheSave = holdNextSaveUntilItFails(page.backend);
  await pressSaveKey(page);
  const announced = watchAnnouncements();
  await answerWhileHidden(page, failTheSave);
  await comeBackToEpics(page);

  await leaveEpicsByTheRoute(page);
  await comeBackToEpics(page);

  expect(announced).toEqual([BACKEND_UNREACHABLE_WORDS]);
});

test("two answers that land while the page is hidden are both spoken when it comes back", async () => {
  const page = await openEpicsThroughTheShell();
  await typeIntoEpic(page, BAKERY, "draftwords");
  const failTheSave = holdNextSaveUntilItFails(page.backend);
  await pressSaveKey(page);
  await typeIntoEpic(page, COOKBOOK, "otherwords");
  const releaseTheSave = page.backend.holdNextSaves();
  await pressSaveKey(page);

  await answerWhileHidden(page, () => {
    failTheSave();
    releaseTheSave();
  });
  await comeBackToEpics(page);

  expect(announcementRegion().textContent).toBe(`${BACKEND_UNREACHABLE_WORDS} ${SAVED_WORDS}`);
});

test("an Add answered while the page is hidden is spoken when the page comes back", async () => {
  const page = await openEpicsThroughTheShell();
  await page.user.type(titleBox(), "A third epic");
  const failTheSave = holdNextSaveUntilItFails(page.backend);
  await page.user.keyboard("{Enter}");
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));

  await answerWhileHidden(page, failTheSave);
  await comeBackToEpics(page);

  expect(announcementRegion().textContent).toBe(BACKEND_UNREACHABLE_WORDS);
});

test("a removal answered while the page is hidden is spoken when the page comes back", async () => {
  const page = await openEpicsThroughTheShell();
  await page.user.click(screen.getByRole("button", { name: `Remove ${BAKERY} epic` }));
  const releaseTheSave = page.backend.holdNextSaves();
  await page.user.click(await screen.findByRole("button", { name: "Remove epic" }));
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));

  await answerWhileHidden(page, releaseTheSave);
  await comeBackToEpics(page);

  expect(announcementRegion().textContent).toBe(SAVED_WORDS);
});

test("a hidden page reads nothing and catches up when it comes back", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const backend = new FakeBackend();
  const page = await openEpicsThroughTheShell(backend);
  await leaveEpicsByTheRoute(page);
  const readsWhenItLeft = readsSoFar(backend);
  backend.markdown = MARKDOWN_WITH_NEW_WORDS;

  await act(() => vi.advanceTimersByTimeAsync(3 * REFRESH_INTERVAL_MILLISECONDS));
  await act(async () => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  expect(readsSoFar(backend)).toBe(readsWhenItLeft);

  await comeBackToEpics(page);
  expect(page.panel().textContent).toContain("evening foot traffic");
  const readsAfterComingBack = readsSoFar(backend);
  expect(readsAfterComingBack).toBeGreaterThan(readsWhenItLeft);

  await act(() => vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MILLISECONDS));
  expect(readsSoFar(backend)).toBeGreaterThan(readsAfterComingBack);
});

test("a page hidden for an hour comes back with what it showed while its read is on the way", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const backend = new FakeBackend();
  const page = await openEpicsThroughTheShell(backend);
  await page.user.click(editButton(BAKERY));
  await page.user.type(notesBox(BAKERY), "draftwords");
  await leaveEpicsByTheRoute(page);
  await act(() => vi.advanceTimersByTimeAsync(LONGER_THAN_ANY_CACHE_KEEPS_UNUSED_DATA_MILLISECONDS));
  backend.holdPageReads = true;

  await page.goForward();
  await page.goForward();

  expect(notesBox(BAKERY).value).toContain("draftwords");
  expect(screen.queryByRole("button", { name: `Dismiss the notice about ${BAKERY} epic` })).toBeNull();
  backend.holdPageReads = false;
  backend.heldPageReads.forEach(({ release }) => release());
  await page.settle();
});

test("the title follows the address when the page is hidden and shown again", async () => {
  const page = await openThroughTheShell();
  expect(document.title).toBe(PAGE_TITLE);

  await page.goBack();
  await page.settle();
  expect(document.title).toBe("Throne");

  await page.goForward();
  await page.settle();
  expect(document.title).toBe(PAGE_TITLE);
});

test("the browser's save key is refused only while the page shows", async () => {
  const pressSaveKey = () => !document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }));
  const page = await openThroughTheShell();
  expect(pressSaveKey()).toBe(true);

  await page.goBack();
  await page.settle();
  expect(pressSaveKey()).toBe(false);

  await page.goForward();
  await page.settle();
  expect(pressSaveKey()).toBe(true);
});

test("leaving with the removal question open closes it, frees the shell and sends nothing", async () => {
  const page = await leaveWithTheRemovalQuestionOpen();

  expect(window.location.pathname).toBe(APP_PATH);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  await page.goForward();
  await page.settle();

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(page.backend.saveBodies).toEqual([]);
});
