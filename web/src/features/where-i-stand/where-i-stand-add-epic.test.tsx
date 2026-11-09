import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { SAVE_ALREADY_ON_ITS_WAY_WORDS } from "@/features/where-i-stand/save-page-unit";
import { EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, watchAnnouncements, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const NEEDS_A_TITLE_WORDS = "Not saved: an epic needs a title.";
const LOCK_HELD_WORDS = "Not saved: the page's edit lock is held by alpha-oven; save again once it is released.";
const titleField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Title" });
const notesField = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" });
const addButton = () => screen.getByRole("button", { name: "Add epic" });
const statusOf = () => document.querySelector(".add-epic .unit-status")?.textContent;
const announcement = () => document.querySelector(".visually-hidden")?.textContent;

async function fillIn(page: OpenedPage, title: string, notes: string) {
  await page.user.clear(titleField());
  await page.user.clear(notesField());
  if (title !== "") await page.user.type(titleField(), title);
  if (notes !== "") await page.user.type(notesField(), notes);
}

async function submitEpic(page: OpenedPage, title: string, notes = "") {
  await fillIn(page, title, notes);
  await page.user.click(addButton());
  await page.settle();
}

async function startHeldAdd(page: OpenedPage, title: string) {
  const answerTheAdd = page.backend.holdNextSaves();
  await fillIn(page, title, "");
  await page.user.click(addButton());
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));
  return answerTheAdd;
}

test("the Lord can add an epic with a title and notes from the Epics tab", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await submitEpic(page, "  Bake for the harbour market  ", " Ask about a stall.\nPrice the rye. ");

  expect(page.backend.markdown).toMatch(/## Epics\n\n### Bake for the harbour market\n\nAsk about a stall\.\nPrice the rye\.\n\n### Open a second bakery/);
  expect(page.headings(3)[0]).toBe("Bake for the harbour market");
  expect(titleField().value).toBe("");
  expect(notesField().value).toBe("");
  expect(page.backend.saveBodies[0].loaded).toBe("## Epics");
});

test("the Add epic form is hidden on every tab but Epics", async () => {
  const page = await openPage();

  expect(screen.queryByRole("button", { name: "Add epic" })).toBeNull();
  await page.chooseTab("Epics");
  expect(addButton()).toBeTruthy();
  await page.chooseTab("Queue");
  expect(screen.queryByRole("button", { name: "Add epic" })).toBeNull();
});

test("an epic can be added with no notes", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await submitEpic(page, "Bake for the harbour market");

  expect(page.backend.markdown).toMatch(/## Epics\n\n### Bake for the harbour market\n\n### Open a second bakery/);
});

test("an epic can be added to a page that has no Epics section yet", async () => {
  const page = await openPage(new FakeBackend(SAMPLE_MARKDOWN.replace(/\n## Epics\n[\s\S]*$/, "")), EPICS_HASH);

  await submitEpic(page, "Bake for the harbour market");

  expect(page.backend.markdown).toMatch(/## Epics\n\n### Bake for the harbour market\n/);
  expect(page.headings(3)).toEqual(["Bake for the harbour market"]);
});

test("an epic with no title is refused without saving", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await submitEpic(page, "   ", "Ask about a stall.");

  expect(page.backend.saveBodies).toEqual([]);
  expect(statusOf()).toBe("Not saved: an epic needs a title.");
  expect(notesField().value).toBe("Ask about a stall.");
});

test("an epic whose title is already on the page is refused without saving", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await submitEpic(page, "Open a second bakery");
  expect(statusOf()).toBe("Not saved: that title is already on the page.");
  await submitEpic(page, "alpha-oven");

  expect(page.backend.saveBodies).toEqual([]);
  expect(statusOf()).toBe("Not saved: that title is already on the page.");
  expect(titleField().value).toBe("alpha-oven");
});

test("pressing Add epic twice while the add is on its way sends it only once", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.type(titleField(), "Bake for the harbour market");
  const releaseSave = page.backend.holdNextSaves();

  await page.user.click(addButton());
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));
  await page.user.click(addButton());
  releaseSave();
  await page.settle();

  expect(page.backend.saveBodies).toHaveLength(1);
});

test("what is typed while an epic is on its way is kept", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.type(titleField(), "Bake for the harbour market");
  page.backend.holdPageReads = true;

  await page.user.click(addButton());
  await fillIn(page, "Bake for the station", "Ask the stationmaster.");
  page.backend.holdPageReads = false;
  page.backend.heldPageReads.forEach(({ release }) => release());
  await page.settle();

  expect(page.backend.markdown).toMatch(/### Bake for the harbour market/);
  expect(titleField().value).toBe("Bake for the station");
  expect(notesField().value).toBe("Ask the stationmaster.");
});

test("a refusal goes away once the Lord types again", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await submitEpic(page, "   ");

  await page.user.type(titleField(), "B");

  expect(statusOf()).toBe("");
});

test("a refusal that goes away leaves its words in no status region", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(addButton());
  await waitFor(() => expect(statusOf()).toBe(NEEDS_A_TITLE_WORDS));
  expect(announcement()).toBe(NEEDS_A_TITLE_WORDS);

  await page.user.type(titleField(), "a");

  expect(announcement()).toBe("");
});

test("the same refusal pressed twice is announced twice", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const announced = watchAnnouncements();

  await page.user.click(addButton());
  await waitFor(() => expect(announced).toHaveLength(2));
  await page.settle();
  await page.user.click(addButton());
  await waitFor(() => expect(announced).toHaveLength(4));

  expect(announced.at(-1)).toBe(announced[1]);
});

test("a title written to the page since it loaded is refused", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  page.backend.markdown = SAMPLE_MARKDOWN.replace("## Epics\n", "## Epics\n\n### Bake for the harbour market\n");

  await submitEpic(page, "Bake for the harbour market");

  expect(page.backend.saveBodies).toEqual([]);
  expect(statusOf()).toBe("Not saved: that title is already on the page.");
});

test("a notes line that would start a section or an entry is refused and the notes are kept", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  for (const notes of ["Ask first.\n### About stalls", "Ask first.\n## About stalls"]) {
    await submitEpic(page, "Bake for the harbour market", notes);

    expect(page.backend.saveBodies).toEqual([]);
    expect(statusOf()).toMatch(/^Not saved: .*Use #### or bold text\.$/);
    expect(notesField().value).toBe(notes);
  }
});

test("a fourth level heading in the notes stays in the epic", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await submitEpic(page, "Bake for the harbour market", "Ask first.\n#### About stalls");

  expect(page.backend.markdown).toMatch(/### Bake for the harbour market\n\nAsk first\.\n#### About stalls/);
});

test("what is typed in the Add epic form survives a page refresh and a change of tab", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await fillIn(page, "Bake for the harbour", "Ask about");

  await page.refreshWith(SAMPLE_MARKDOWN.replace("Find a street", "Find a square"));
  await page.chooseTab("Queue");
  await page.chooseTab("Epics");

  expect(within(page.panel()).getByText(/Find a square/)).toBeTruthy();
  expect(titleField().value).toBe("Bake for the harbour");
  expect(notesField().value).toBe("Ask about");
});

test("a failed add keeps what was typed and shows why", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  page.backend.answerToNextSaves = () => Response.json({ outcome: "lock-held", message: LOCK_HELD_WORDS }, { status: 409 });

  await submitEpic(page, "Bake for the harbour market", "Ask about a stall.");

  await waitFor(() => expect(statusOf()).toBe(LOCK_HELD_WORDS));
  expect(announcement()).toBe(LOCK_HELD_WORDS);
  expect(titleField().value).toBe("Bake for the harbour market");
  expect(notesField().value).toBe("Ask about a stall.");
  expect(page.backend.markdown).toBe(SAMPLE_MARKDOWN);
});

test("an Add pressed while an add is on its way says it was not sent", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheAdd = await startHeldAdd(page, "Bake for the harbour market");

  await page.user.click(addButton());

  expect(statusOf()).toBe(SAVE_ALREADY_ON_ITS_WAY_WORDS);
  expect(announcement()).toBe(SAVE_ALREADY_ON_ITS_WAY_WORDS);
  expect(addButton()).toHaveProperty("disabled", false);
  answerTheAdd();
  await page.settle();

  expect(page.backend.saveBodies).toHaveLength(1);
});

test("text left in the Add form after an add lands is not reported as saved", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheAdd = await startHeldAdd(page, "Bake for the harbour market");

  await page.user.type(titleField(), " stall");
  answerTheAdd();
  await page.settle();

  expect(page.backend.markdown).toContain("### Bake for the harbour market\n");
  expect(titleField().value).toBe("Bake for the harbour market stall");
  expect(statusOf()).toBe("Saved what was sent. The text now in this form is not saved.");
  expect(announcement()).toBe("Saved what was sent. The text now in this form is not saved.");
});

async function pressAddWhileThePageReadIsHeld(page: OpenedPage) {
  page.backend.holdPageReads = true;
  await page.user.click(addButton());
  await waitFor(() => expect(page.backend.heldPageReads).toHaveLength(1));
  page.backend.holdPageReads = false;
  return () => page.backend.heldPageReads.forEach(({ release }) => release());
}

test("a late Add refusal changes nothing once the form's text has changed", async () => {
  const repeatedTitle = "Bake for the harbour market";
  const markdown = SAMPLE_MARKDOWN.replace("## Epics\n", `## Epics\n\n### ${repeatedTitle}\n`);
  for (const [titleSent, titleTyped] of [["", "abc"], [repeatedTitle, "z"]]) {
    const page = await openPage(new FakeBackend(markdown), EPICS_HASH);
    if (titleSent !== "") await page.user.type(titleField(), titleSent);
    const answerTheRead = await pressAddWhileThePageReadIsHeld(page);
    await page.user.type(titleField(), titleTyped);
    const announced = watchAnnouncements();

    answerTheRead();
    await page.settle();

    expect(statusOf()).toBe("");
    expect(announcement()).toBe("");
    expect(announced.filter((words) => words !== "")).toEqual([]);
    expect(titleField().value).toBe(`${titleSent}${titleTyped}`);
    expect(page.backend.saveBodies).toEqual([]);
  }
});

test("a late Add refusal still speaks when the form holds what was sent again", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRead = await pressAddWhileThePageReadIsHeld(page);
  await page.user.type(titleField(), "a{Backspace}");

  answerTheRead();
  await page.settle();

  expect(statusOf()).toBe(NEEDS_A_TITLE_WORDS);
  expect(announcement()).toBe(NEEDS_A_TITLE_WORDS);
});

test("a late Add refusal takes away the words of an Add pressed while it travelled", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRead = await pressAddWhileThePageReadIsHeld(page);
  await page.user.type(titleField(), "abc");
  await page.user.click(addButton());
  expect(statusOf()).toBe(SAVE_ALREADY_ON_ITS_WAY_WORDS);

  answerTheRead();
  await page.settle();

  expect(statusOf()).toBe("");
  expect(announcement()).toBe("");
});

async function startAddThatWillFail(page: OpenedPage, title: string) {
  let failTheSave = () => undefined as void;
  page.backend.answerToNextSaves = () => new Promise((answer) => (failTheSave = () => answer(Response.json({ outcome: "lock-held", message: LOCK_HELD_WORDS }, { status: 409 }))));
  await page.user.type(titleField(), title);
  await page.user.click(addButton());
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));
  return () => failTheSave();
}

test("a failed add that lands after the form's text changed says the text now in the form was not sent", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const failTheSave = await startAddThatWillFail(page, "Bake for the harbour market");

  await page.user.type(titleField(), " stall");
  failTheSave();
  await page.settle();

  const failureWords = `${LOCK_HELD_WORDS} The text now in this form was not sent.`;
  expect(statusOf()).toBe(failureWords);
  expect(announcement()).toBe(failureWords);
  expect(titleField().value).toBe("Bake for the harbour market stall");
});

test("a failed add that lands on a form emptied since says only that it failed", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const failTheSave = await startAddThatWillFail(page, "Bake for the harbour market");

  await page.user.clear(titleField());
  failTheSave();
  await page.settle();

  expect(statusOf()).toBe(LOCK_HELD_WORDS);
  expect(announcement()).toBe(LOCK_HELD_WORDS);
});
