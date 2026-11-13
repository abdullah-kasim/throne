import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { BAKERY, COOKBOOK, editButton, EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const PULL_REQUESTS_HASH = "#pull-requests";
const VANISHED_WORDS = "This epic changed on the page before you saved it, so your text was not saved.";
const MARKDOWN_WITHOUT_THE_BAKERY = SAMPLE_MARKDOWN.replace("### Open a second bakery\nFind a street with morning foot traffic.\n\n", "");
const COOKBOOK_EPIC = `### ${COOKBOOK}\n- Kind: throne — not a real kind\n`;
const MARKDOWN_WITH_THE_BAKERY_CHANGED = SAMPLE_MARKDOWN.replace("Find a street", "Find a quiet street");

const editor = (title: string) => screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${title} epic` });
const saveButton = (title: string) => screen.getByRole("button", { name: `Save ${title} epic` });
const statusWords = () => screen.getAllByRole("status").map(({ textContent }) => textContent);

async function openEditorWithUnsavedText(page: OpenedPage, title: string) {
  await page.user.click(editButton(title));
  await page.user.type(editor(title), "more");
}

test("Tab from the Epics tab goes straight to the Title box", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  page.tab("Epics").focus();
  await page.user.tab();

  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Title" }));
});

test("Tab from a tab whose panel opens on plain text stops on the panel, so it can be scrolled", async () => {
  const page = await openPage();

  page.tab("Now").focus();
  await page.user.tab();

  expect(document.activeElement).toBe(page.panel());
});

test("Escape in an editor with nothing unsaved closes it and leaves focus on its Edit button", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));

  await page.user.keyboard("{Escape}");

  expect(screen.queryByRole("textbox", { name: `${BAKERY} epic` })).toBeNull();
  expect(document.activeElement).toBe(editButton(BAKERY));
});

test("Escape in an editor with unsaved text keeps the editor and the text", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);

  await page.user.keyboard("{Escape}");

  expect(editor(BAKERY).value).toContain("more");
  expect(document.activeElement).toBe(editor(BAKERY));
});

test("Escape while notes are saving leaves the editor open and focus where it was", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  await page.user.type(editor(BAKERY), "!");
  const answerTheSave = page.backend.holdNextSaves();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.keyboard("{Backspace}");
  await page.user.keyboard("{Escape}");

  expect(document.activeElement).toBe(editor(BAKERY));
  answerTheSave();
  await page.settle();
  expect(document.activeElement).toBe(editor(BAKERY));
});

test("Escape in the removal question closes the question and leaves the editor open", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  await page.user.click(screen.getByRole("button", { name: `Remove ${BAKERY} epic` }));
  await screen.findByRole("alertdialog");

  await page.user.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(editor(BAKERY)).toBeTruthy();
});

test("a save from the Save button leaves focus in the notes box after the button goes", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);

  await page.user.click(saveButton(BAKERY));
  await page.settle();

  expect(screen.queryByRole("button", { name: `Save ${BAKERY} epic` })).toBeNull();
  expect(document.activeElement).toBe(editor(BAKERY));
});

test("a refused save from the Save button leaves focus in the notes box", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);
  page.backend.markdown = MARKDOWN_WITH_THE_BAKERY_CHANGED;

  await page.user.click(saveButton(BAKERY));
  await page.settle();

  expect(screen.getByText(/Your text that was not saved/)).toBeTruthy();
  expect(document.activeElement).toBe(editor(BAKERY));
});

test("Cmd or Ctrl S on the toggle moves focus to the notes box, because the toggle turns disabled", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);
  const answerTheSave = page.backend.holdNextSaves();

  screen.getByRole("button", { name: `Discard changes to ${BAKERY} epic` }).focus();
  await page.user.keyboard("{Control>}s{/Control}");

  expect(document.activeElement).toBe(editor(BAKERY));
  answerTheSave();
  await page.settle();
});

test("an epic vanishing under focus hands focus to the selected tab and says so", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);

  await page.refreshWith(MARKDOWN_WITHOUT_THE_BAKERY);

  expect(document.activeElement).toBe(page.tab("Epics"));
  expect(statusWords()).toContain(VANISHED_WORDS);
});

test("a second epic vanishing is announced as the first was", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);
  await openEditorWithUnsavedText(page, COOKBOOK);
  const region = screen.getAllByRole("status").at(-1) as HTMLElement;
  await page.refreshWith(MARKDOWN_WITHOUT_THE_BAKERY);
  const announced: string[] = [];
  new MutationObserver(() => announced.push(region.textContent)).observe(region, { childList: true });

  await page.refreshWith(MARKDOWN_WITHOUT_THE_BAKERY.replace(COOKBOOK_EPIC, ""));

  expect(announced).toEqual([VANISHED_WORDS]);
});

test("dismissing the vanished notice names its epic and hands focus to the selected tab", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);
  await page.refreshWith(MARKDOWN_WITHOUT_THE_BAKERY);

  await page.user.click(screen.getByRole("button", { name: `Dismiss the notice about ${BAKERY} epic` }));

  expect(document.activeElement).toBe(page.tab("Epics"));
  expect(statusWords()).not.toContain(VANISHED_WORDS);
});

test("focus the Lord moved off every control stays off them when the control he left vanishes in a refresh", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  editButton(BAKERY).focus();
  editButton(BAKERY).blur();

  await page.refreshWith(MARKDOWN_WITHOUT_THE_BAKERY);

  expect(screen.queryByRole("button", { name: `Edit ${BAKERY} epic` })).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

test("text typed while a save is on its way is announced as unsaved, as the epic shows it", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditorWithUnsavedText(page, BAKERY);
  const answerTheSave = page.backend.holdNextSaves();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.type(editor(BAKERY), " still typing");
  answerTheSave();
  await page.settle();

  await waitFor(() => expect(statusWords()).toContain("Unsaved changes."));
  expect(statusWords()).not.toContain("Saved.");
});

test("a tab whose count is not known yet is named by its words alone", async () => {
  const backend = new FakeBackend();
  backend.recordsAnswer = Response.json({ outcome: "failed", message: "gone" }, { status: 500 });
  const page = await openPage(backend);

  expect(page.tab("Pull requests").getAttribute("aria-label")).toBe("Pull requests");
});

test("the page's title and its one first-level heading are Where I stand", async () => {
  await openPage();

  expect(document.title).toBe("Where I stand");
  expect(screen.getAllByRole("heading", { level: 1 }).map(({ textContent }) => textContent)).toEqual(["Where I stand"]);
});

test("going back from the page gives the address's own title", async () => {
  document.title = "Throne";
  const page = await openPage(new FakeBackend(), "", "/throne/");
  await page.user.click(screen.getByRole("link", { name: "Where I stand" }));
  await waitFor(() => expect(document.title).toBe("Where I stand"));

  await page.goBack();

  expect(window.location.pathname).toBe("/throne/");
  expect(document.title).toBe("Throne");
});

function browserRestoresThePage(persisted: boolean) {
  (document.activeElement as HTMLElement).blur();
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
}

async function followFirstLink(page: OpenedPage): Promise<HTMLElement> {
  const [link] = within(page.panel()).getAllByRole("link");
  link.addEventListener("click", (event) => event.preventDefault());
  await page.user.click(link);
  return link;
}

test("a page the browser restores puts focus back on the link that left it", async () => {
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  const link = await followFirstLink(page);

  browserRestoresThePage(true);

  expect(document.activeElement).toBe(link);
});

test("a page loaded afresh does not take focus for a link followed earlier", async () => {
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  await followFirstLink(page);

  browserRestoresThePage(false);

  expect(document.activeElement).toBe(document.body);
});

test("going back with focus on nothing lands on the selected tab", async () => {
  const page = await openPage();
  await page.chooseTab("Queue");
  (document.activeElement as HTMLElement).blur();

  await page.goBack();

  await waitFor(() => expect(page.selectedTabs()).toEqual(["Now"]));
  expect(document.activeElement).toBe(page.tab("Now"));
});

test("a restored page hands focus to the selected tab when the link that left it is on a hidden tab", async () => {
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  await followFirstLink(page);
  act(() => page.tab("Now").focus());
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Now"]));

  browserRestoresThePage(true);

  expect(document.activeElement).toBe(page.tab("Now"));
});

test("a restored page hands focus to the selected tab when the link that left it has gone", async () => {
  const page = await openPage(new FakeBackend());
  const link = await followFirstLink(page);
  await page.refreshWith(SAMPLE_MARKDOWN.replace(/### alpha-giftcard\n[^]*?\n\n/, ""));
  expect(link.isConnected).toBe(false);

  browserRestoresThePage(true);

  expect(document.activeElement).toBe(page.tab("Now"));
});

test("a restored page leaves focus alone when the last click was not on a link", async () => {
  const page = await openPage(new FakeBackend(), PULL_REQUESTS_HASH);
  await followFirstLink(page);
  await page.user.click(document.body);

  browserRestoresThePage(true);

  expect(document.activeElement).toBe(document.body);
});
