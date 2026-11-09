import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { editButton, ENTRY_REPEATED_WORDS, EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const RYE = "Bake rye";
const SECOND_RYE = `${RYE} (2)`;
const FIRST_RYE_EPIC = `### ${RYE}\n\nfirst notes`;
const SECOND_RYE_EPIC = `### ${RYE}\n\nsecond notes`;
const RYE_WITHOUT_NOTES = `### ${RYE}`;
const LONGER_RYE_EPIC = `${FIRST_RYE_EPIC}\nand a longer tail`;
const CHANGED_RYE_EPIC = `### ${RYE}\n\nchanged by another writer`;
const SPELT = "Bake spelt";
const SPELT_EPIC = `### ${SPELT}\n\nspelt notes`;
const SAVED_WORDS = "Saved.";
const ENTRY_CHANGED_WORDS = "this entry changed since the page loaded";
const WORDS_KEPT_ASIDE_HEADING = /Your text that was not saved/;

const TWO_PLACES_BEGINNING_WITH_THE_OLD_TEXT = [
  [FIRST_RYE_EPIC, [LONGER_RYE_EPIC, FIRST_RYE_EPIC]],
  [RYE_WITHOUT_NOTES, [`${RYE_WITHOUT_NOTES}\n\nnotes from elsewhere`, RYE_WITHOUT_NOTES]],
] as const;

const pageHolding = (...epics: string[]) => `${SAMPLE_MARKDOWN}\n${epics.join("\n\n")}\n`;
const notesBox = (title: string) => screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${title} epic` });
const epicBlockOf = (title: string) => screen.getByRole("button", { name: `Remove ${title} epic` }).closest(".epic") as HTMLElement;

async function openPageHolding(...epics: string[]): Promise<OpenedPage> {
  return openPage(new FakeBackend(pageHolding(...epics)), EPICS_HASH);
}

async function typeIntoEpic(page: OpenedPage, title: string, words: string) {
  await page.user.click(editButton(title));
  await page.user.type(notesBox(title), words);
}

async function saveWithTheKeyboard(page: OpenedPage) {
  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();
}

async function confirmRemoval(page: OpenedPage, title: string) {
  await page.user.click(screen.getByRole("button", { name: `Remove ${title} epic` }));
  await screen.findByRole("alertdialog");
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));
  await page.settle();
}

test("two epics of one heading open, type and save apart", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);

  await typeIntoEpic(page, RYE, " and more");

  expect(screen.queryByRole("textbox", { name: `${SECOND_RYE} epic` })).toBeNull();
  await page.user.click(editButton(SECOND_RYE));
  expect(notesBox(RYE).value).toBe("first notes and more");
  expect(notesBox(SECOND_RYE).value).toBe("second notes");

  await page.user.click(notesBox(RYE));
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(`${FIRST_RYE_EPIC} and more`, SECOND_RYE_EPIC));
  expect(epicBlockOf(RYE).textContent).toContain("Saved");
  expect(epicBlockOf(SECOND_RYE).textContent).not.toContain("Saved");
});

test("the second of two epics of one heading saves to the second", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);

  await typeIntoEpic(page, SECOND_RYE, " and more");
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(FIRST_RYE_EPIC, `${SECOND_RYE_EPIC} and more`));
});

test("removing one of two epics of one heading removes that one", async () => {
  for (const [title, epicLeft] of [
    [RYE, SECOND_RYE_EPIC],
    [SECOND_RYE, FIRST_RYE_EPIC],
  ]) {
    const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);

    await confirmRemoval(page, title);

    expect(page.backend.markdown).toBe(pageHolding(epicLeft));
    expect(document.querySelectorAll(".epic")).toHaveLength(3);
  }
});

test("the removal question names which of two epics of one heading it will remove", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);

  await page.user.click(screen.getByRole("button", { name: `Remove ${SECOND_RYE} epic` }));

  expect(await screen.findByRole("heading", { name: `Remove epic '${SECOND_RYE}'?` })).toBeTruthy();
});

test("removing the first of two epics of one heading leaves the words typed into the second", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await typeIntoEpic(page, SECOND_RYE, " and more");

  await confirmRemoval(page, RYE);

  expect(notesBox(RYE).value).toBe("second notes and more");
  expect(screen.queryByText(WORDS_KEPT_ASIDE_HEADING)).toBeNull();

  await page.user.click(notesBox(RYE));
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(`${SECOND_RYE_EPIC} and more`));
});

test("a save answered after its namesake was removed shows on the epic that was saved", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await typeIntoEpic(page, SECOND_RYE, " and more");
  const releaseTheSaves = page.backend.holdNextSaves();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.click(screen.getByRole("button", { name: `Remove ${RYE} epic` }));
  await screen.findByRole("alertdialog");
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));
  releaseTheSaves();
  await page.settle();

  expect(page.backend.markdown).toBe(pageHolding(`${SECOND_RYE_EPIC} and more`));
  expect(epicBlockOf(RYE).textContent).toContain(SAVED_WORDS);
});

test("the epic left when its namesake goes is named by its heading alone", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);

  await confirmRemoval(page, RYE);

  expect(screen.queryByRole("button", { name: `Edit ${SECOND_RYE} epic` })).toBeNull();
  expect(editButton(RYE).closest(".epic")?.textContent).toContain("second notes");
});

test("a refresh keeps each of two epics of one heading on its own words", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await typeIntoEpic(page, RYE, " for the first");
  await typeIntoEpic(page, SECOND_RYE, " for the second");

  await page.refresh();
  await page.refreshWith(pageHolding(FIRST_RYE_EPIC.replace("first notes", "first notes moved"), SECOND_RYE_EPIC));

  expect(notesBox(RYE).value).toBe("first notes for the first");
  expect(notesBox(SECOND_RYE).value).toBe("second notes for the second");
});

test("words typed into an epic stay on it when another writer removes its namesake", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await typeIntoEpic(page, SECOND_RYE, " and more");

  await page.refreshWith(pageHolding(SECOND_RYE_EPIC));

  expect(notesBox(RYE).value).toBe("second notes and more");
  expect(screen.queryByText(WORDS_KEPT_ASIDE_HEADING)).toBeNull();
});

test("saving an epic to its namesake's words leaves the editor on that epic", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await page.user.click(editButton(RYE));
  await page.user.clear(notesBox(RYE));
  await page.user.type(notesBox(RYE), "second notes");

  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(SECOND_RYE_EPIC, SECOND_RYE_EPIC));
  expect(notesBox(RYE).closest(".epic")).toBe(document.querySelectorAll(".epic")[2]);
  expect(screen.queryByRole("textbox", { name: `${SECOND_RYE} epic` })).toBeNull();
});

test("a save of one of two identical epics is refused in words that say why, and keeps what was typed", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, FIRST_RYE_EPIC);
  await typeIntoEpic(page, RYE, " and more");

  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(FIRST_RYE_EPIC, FIRST_RYE_EPIC));
  expect(epicBlockOf(RYE).textContent).toContain(ENTRY_REPEATED_WORDS);
  expect(epicBlockOf(SECOND_RYE).textContent).not.toContain(ENTRY_REPEATED_WORDS);
  expect(notesBox(RYE).value).toBe("first notes and more");
});

test("words typed into an epic never save onto the namesake that now holds its old text", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, FIRST_RYE_EPIC);
  const changedElsewhere = pageHolding(SECOND_RYE_EPIC, FIRST_RYE_EPIC);
  await typeIntoEpic(page, RYE, " and more");
  await page.refreshWith(changedElsewhere);

  await page.user.click(notesBox(RYE));
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(changedElsewhere);
  expect(epicBlockOf(RYE).textContent).toContain("this entry changed since the page loaded");
  expect(epicBlockOf(RYE).textContent).toContain("first notes and more");
});

test("a removal of one of two identical epics is refused in words that say why", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, FIRST_RYE_EPIC);

  await confirmRemoval(page, SECOND_RYE);

  expect(page.backend.markdown).toBe(pageHolding(FIRST_RYE_EPIC, FIRST_RYE_EPIC));
  expect(epicBlockOf(SECOND_RYE).textContent).toContain(ENTRY_REPEATED_WORDS);
  expect(epicBlockOf(RYE).textContent).not.toContain(ENTRY_REPEATED_WORDS);
});

test("an epic with no notes saves and goes on its own beside a namesake that has some", async () => {
  for (const [order, title] of [
    [[RYE_WITHOUT_NOTES, SECOND_RYE_EPIC], RYE],
    [[SECOND_RYE_EPIC, RYE_WITHOUT_NOTES], SECOND_RYE],
  ] as const) {
    const page = await openPageHolding(...order);
    await typeIntoEpic(page, title, "new notes");
    await saveWithTheKeyboard(page);
    expect(page.backend.markdown).toBe(pageHolding(...order.map((epic) => (epic === RYE_WITHOUT_NOTES ? `${RYE_WITHOUT_NOTES}\nnew notes` : epic))));

    const nextPage = await openPageHolding(...order);
    await confirmRemoval(nextPage, title);
    expect(nextPage.backend.markdown).toBe(pageHolding(SECOND_RYE_EPIC));
  }
});

test("a save meant for one epic of a heading refuses when the text it matches belongs to the other", async () => {
  for (const [before, changedElsewhere, pageHasReadTheChange] of [
    [[FIRST_RYE_EPIC, LONGER_RYE_EPIC], [CHANGED_RYE_EPIC, LONGER_RYE_EPIC], true],
    [[FIRST_RYE_EPIC, LONGER_RYE_EPIC], [CHANGED_RYE_EPIC, LONGER_RYE_EPIC], false],
    [[FIRST_RYE_EPIC, FIRST_RYE_EPIC], [CHANGED_RYE_EPIC, FIRST_RYE_EPIC], false],
  ] as const) {
    const page = await openPageHolding(...before);
    await typeIntoEpic(page, RYE, "kept words");
    page.backend.markdown = pageHolding(...changedElsewhere);
    if (pageHasReadTheChange) await page.refresh();

    await page.user.click(notesBox(RYE));
    await saveWithTheKeyboard(page);

    expect(page.backend.markdown).toBe(pageHolding(...changedElsewhere));
    expect(epicBlockOf(RYE).textContent).toContain(ENTRY_CHANGED_WORDS);
    expect(epicBlockOf(RYE).textContent).toContain("kept words");
  }
});

test("a refused save is spoken a moment after the box shows the page's text, so that change cannot cut it off", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await typeIntoEpic(page, RYE, " and more");
  page.backend.markdown = pageHolding(CHANGED_RYE_EPIC, SECOND_RYE_EPIC);
  const region = document.querySelector(".visually-hidden") as Element;
  const boxWhenSpoken: string[] = [];
  new MutationObserver(() => boxWhenSpoken.push(notesBox(RYE).value)).observe(region, { childList: true });

  await saveWithTheKeyboard(page);

  expect(notesBox(RYE).value).toBe("changed by another writer");
  expect(region.textContent).not.toContain(ENTRY_CHANGED_WORDS);
  await waitFor(() => expect(region.textContent).toContain(ENTRY_CHANGED_WORDS));
  expect(boxWhenSpoken.at(-1)).toBe("changed by another writer");
});

test("words typed into an epic another writer removed never land on its namesake", async () => {
  const page = await openPageHolding(RYE_WITHOUT_NOTES, SECOND_RYE_EPIC);
  await typeIntoEpic(page, RYE, "kept words");
  page.backend.markdown = pageHolding(SECOND_RYE_EPIC);

  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(SECOND_RYE_EPIC));
  expect(screen.getByText(WORDS_KEPT_ASIDE_HEADING).parentElement?.textContent).toContain("kept words");
});

test("a removal meant for one epic of a heading refuses when the text it matches belongs to the other", async () => {
  for (const [before, changedElsewhere] of [
    [[FIRST_RYE_EPIC, FIRST_RYE_EPIC], [CHANGED_RYE_EPIC, FIRST_RYE_EPIC]],
    [[FIRST_RYE_EPIC, SECOND_RYE_EPIC], [SECOND_RYE_EPIC, SECOND_RYE_EPIC]],
  ] as const) {
    const page = await openPageHolding(...before);
    page.backend.markdown = pageHolding(...changedElsewhere);

    await confirmRemoval(page, RYE);

    expect(page.backend.markdown).toBe(pageHolding(...changedElsewhere));
    expect(epicBlockOf(RYE).textContent).toContain(ENTRY_CHANGED_WORDS);
  }
});

test("words typed into an epic save to it after another writer removes the namesake above it", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC);
  await typeIntoEpic(page, SECOND_RYE, " and more");
  await page.refreshWith(pageHolding(SECOND_RYE_EPIC));

  await page.user.click(notesBox(RYE));
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(`${SECOND_RYE_EPIC} and more`));
});

test("words typed into an epic save to it after another writer adds a namesake above it", async () => {
  const page = await openPageHolding(SECOND_RYE_EPIC);
  await typeIntoEpic(page, RYE, " and more");
  await page.refreshWith(pageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC));

  await page.user.click(notesBox(SECOND_RYE));
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding(FIRST_RYE_EPIC, `${SECOND_RYE_EPIC} and more`));
});

test("an entry of the same heading in another section does not move an epic's place", async () => {
  const page = await openPageHolding("### alpha-oven\n\nfirst notes", "### alpha-oven\n\nsecond notes");

  await typeIntoEpic(page, "alpha-oven (2)", " and more");
  await saveWithTheKeyboard(page);

  expect(page.backend.markdown).toBe(pageHolding("### alpha-oven\n\nfirst notes", "### alpha-oven\n\nsecond notes and more"));
});

test("a save on an epic of a unique heading keeps working after another writer appends a line", async () => {
  for (const pageHasReadTheChange of [false, true]) {
    const page = await openPageHolding(FIRST_RYE_EPIC, SPELT_EPIC);
    await typeIntoEpic(page, RYE, " and more");
    page.backend.markdown = pageHolding(`${FIRST_RYE_EPIC}\nappended elsewhere`, SPELT_EPIC);
    if (pageHasReadTheChange) await page.refresh();

    await page.user.click(notesBox(RYE));
    await saveWithTheKeyboard(page);

    expect(page.backend.markdown).toBe(pageHolding(`${FIRST_RYE_EPIC} and more\nappended elsewhere`, SPELT_EPIC));
    expect(epicBlockOf(RYE).textContent).toContain(SAVED_WORDS);
    expect(screen.queryByText(WORDS_KEPT_ASIDE_HEADING)).toBeNull();
  }
});

test("a save on a heading-only epic of a unique heading keeps working after another writer adds notes", async () => {
  for (const pageHasReadTheChange of [false, true]) {
    const page = await openPageHolding(RYE_WITHOUT_NOTES, SPELT_EPIC);
    await typeIntoEpic(page, RYE, "kept words");
    page.backend.markdown = pageHolding(`${RYE_WITHOUT_NOTES}\n\nnotes from elsewhere`, SPELT_EPIC);
    if (pageHasReadTheChange) await page.refresh();

    await page.user.click(notesBox(RYE));
    await saveWithTheKeyboard(page);

    expect(page.backend.markdown).toBe(pageHolding(`${RYE_WITHOUT_NOTES}\nkept words\n\nnotes from elsewhere`, SPELT_EPIC));
    expect(epicBlockOf(RYE).textContent).toContain(SAVED_WORDS);
    expect(screen.queryByText(WORDS_KEPT_ASIDE_HEADING)).toBeNull();
  }
});

test("a save names its entry only when the page holds that heading more than once", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC, SPELT_EPIC);

  await typeIntoEpic(page, SPELT, " and more");
  await saveWithTheKeyboard(page);
  await typeIntoEpic(page, SECOND_RYE, " and more");
  await saveWithTheKeyboard(page);

  expect(page.backend.saveBodies).toEqual([
    { loaded: SPELT_EPIC, edited: `${SPELT_EPIC} and more` },
    { loaded: SECOND_RYE_EPIC, edited: `${SECOND_RYE_EPIC} and more`, headingOccurrence: 2 },
  ]);
});

test("a removal names its entry only when the page holds that heading more than once", async () => {
  const page = await openPageHolding(FIRST_RYE_EPIC, SECOND_RYE_EPIC, SPELT_EPIC);

  await confirmRemoval(page, SPELT);
  await confirmRemoval(page, SECOND_RYE);

  expect(page.backend.saveBodies).toEqual([
    { loaded: SPELT_EPIC, edited: "" },
    { loaded: SECOND_RYE_EPIC, edited: "", headingOccurrence: 2 },
  ]);
});

test("a save naming no entry refuses when two places begin with its text", async () => {
  for (const [readOnce, changedElsewhere] of TWO_PLACES_BEGINNING_WITH_THE_OLD_TEXT) {
    const page = await openPageHolding(readOnce, SPELT_EPIC);
    await typeIntoEpic(page, RYE, "kept words");
    page.backend.markdown = pageHolding(...changedElsewhere, SPELT_EPIC);

    await saveWithTheKeyboard(page);

    expect(page.backend.markdown).toBe(pageHolding(...changedElsewhere, SPELT_EPIC));
    expect(document.querySelector(".where-i-stand")?.textContent).toContain(ENTRY_REPEATED_WORDS);
    expect(document.querySelector(".where-i-stand")?.textContent).toContain("kept words");
  }
});

test("a removal naming no entry refuses when two places begin with its text", async () => {
  for (const [readOnce, changedElsewhere] of TWO_PLACES_BEGINNING_WITH_THE_OLD_TEXT) {
    const page = await openPageHolding(readOnce, SPELT_EPIC);
    page.backend.markdown = pageHolding(...changedElsewhere, SPELT_EPIC);

    await confirmRemoval(page, RYE);

    expect(page.backend.markdown).toBe(pageHolding(...changedElsewhere, SPELT_EPIC));
    expect(document.querySelector(".where-i-stand")?.textContent).toContain(ENTRY_REPEATED_WORDS);
  }
});
