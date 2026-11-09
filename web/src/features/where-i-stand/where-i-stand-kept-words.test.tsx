import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BAKERY, COOKBOOK, editButton, EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const CHANGED_ELSEWHERE_MARKDOWN = SAMPLE_MARKDOWN.replace("morning foot traffic", "evening foot traffic");
const CHANGED_AGAIN_MARKDOWN = SAMPLE_MARKDOWN.replace("morning foot traffic", "midday foot traffic");
const MARKDOWN_WITHOUT_THE_BAKERY = SAMPLE_MARKDOWN.replace("### Open a second bakery\nFind a street with morning foot traffic.\n\n", "");
const MARKDOWN_WITH_A_HEADING_ONLY_EPIC = `${SAMPLE_MARKDOWN}\n### Bake on Sundays\n`;
const HEADING_ONLY = "Bake on Sundays";
const KEPT_WORDS = "lostwords";

const editor = (title: string) => screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${title} epic` });
const buttonNamed = (name: string) => screen.queryByRole("button", { name });
const keptText = (page: OpenedPage) => page.panel().querySelector(".unsaved")?.textContent ?? "";
const statusOfTheBakery = (page: OpenedPage) => page.panel().querySelector(".epic .unit-status")?.textContent;

async function pageKeepingWordsAfterARefusedSave(): Promise<OpenedPage> {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  await page.user.type(editor(BAKERY), KEPT_WORDS);
  page.backend.markdown = CHANGED_ELSEWHERE_MARKDOWN;
  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();
  return page;
}

async function confirmRemoval(page: OpenedPage) {
  await page.user.click(screen.getByRole("button", { name: `Remove ${BAKERY} epic` }));
  await page.user.click(await screen.findByRole("button", { name: "Remove epic" }));
  await page.settle();
}

test("Escape after a refused save keeps the editor and the words the page kept", async () => {
  const page = await pageKeepingWordsAfterARefusedSave();

  await page.user.keyboard("{Escape}");

  expect(document.activeElement).toBe(editor(BAKERY));
  expect(keptText(page)).toContain(KEPT_WORDS);
});

test("the toggle says it discards while the page keeps words from a refused save", async () => {
  const page = await pageKeepingWordsAfterARefusedSave();

  expect(buttonNamed(`Close ${BAKERY} epic`)).toBeNull();
  await page.user.click(screen.getByRole("button", { name: `Discard changes to ${BAKERY} epic` }));

  expect(keptText(page)).toBe("");
  expect(screen.getByRole("button", { name: `Edit ${BAKERY} epic` })).toBeTruthy();
});

test("Escape after a refused removal of an edited epic keeps the editor and the words", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  await page.user.type(editor(BAKERY), KEPT_WORDS);
  page.backend.markdown = CHANGED_ELSEWHERE_MARKDOWN;
  await confirmRemoval(page);

  editor(BAKERY).focus();
  await page.user.keyboard("{Escape}");

  expect(editor(BAKERY)).toBeTruthy();
  expect(keptText(page)).toContain(KEPT_WORDS);
});

test("a refused removal leaves the words an earlier refused save kept", async () => {
  const page = await pageKeepingWordsAfterARefusedSave();
  page.backend.markdown = CHANGED_AGAIN_MARKDOWN;

  await confirmRemoval(page);

  expect(keptText(page)).toContain(KEPT_WORDS);
});

test("a second refused save keeps the words of both", async () => {
  const page = await pageKeepingWordsAfterARefusedSave();
  await page.user.type(editor(BAKERY), "secondtry");
  page.backend.markdown = CHANGED_AGAIN_MARKDOWN;

  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();

  expect(keptText(page)).toContain(KEPT_WORDS);
  expect(keptText(page)).toContain("secondtry");
});

test("a save of other text keeps the words the page kept until they are discarded", async () => {
  const page = await pageKeepingWordsAfterARefusedSave();
  await page.user.type(editor(BAKERY), "othertext");

  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();

  expect(page.backend.markdown).toContain("othertext");
  expect(keptText(page)).toContain(KEPT_WORDS);
  expect(screen.getByRole("button", { name: `Discard changes to ${BAKERY} epic` })).toBeTruthy();
});

test("an epic leaving the page shows the words kept from a refused save beside the words typed since", async () => {
  const page = await pageKeepingWordsAfterARefusedSave();
  await page.user.type(editor(BAKERY), "typedsince");

  await page.refreshWith(MARKDOWN_WITHOUT_THE_BAKERY);

  const notice = screen.getByRole("button", { name: `Dismiss the notice about ${BAKERY} epic` }).closest("section");
  expect(notice?.textContent).toContain(KEPT_WORDS);
  expect(notice?.textContent).toContain("typedsince");
});

test("whitespace typed into a heading-only epic offers no Save and closes as a clean editor does", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_A_HEADING_ONLY_EPIC), EPICS_HASH);
  await page.user.click(editButton(HEADING_ONLY));

  await page.user.type(editor(HEADING_ONLY), "   ");

  expect(editor(HEADING_ONLY).value).toBe("   ");
  expect(buttonNamed(`Save ${HEADING_ONLY} epic`)).toBeNull();
  expect(buttonNamed(`Close ${HEADING_ONLY} epic`)).toBeTruthy();
  expect(page.panel().textContent).not.toContain("Unsaved changes.");
  await page.user.keyboard("{Escape}");
  expect(editButton(HEADING_ONLY)).toBeTruthy();
});

test("spaces typed on the way to more words stay in the box and the words can be saved", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_A_HEADING_ONLY_EPIC), EPICS_HASH);
  await page.user.click(editButton(HEADING_ONLY));

  await page.user.type(editor(HEADING_ONLY), "  bake rye ");

  expect(editor(HEADING_ONLY).value).toBe("  bake rye ");
  await page.user.click(screen.getByRole("button", { name: `Save ${HEADING_ONLY} epic` }));
  await page.settle();
  expect(page.backend.markdown).toContain("### Bake on Sundays\n  bake rye");
});

test("blank lines added after an epic's notes offer no Save", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));

  await page.user.type(editor(BAKERY), "{Enter}{Enter}");

  expect(buttonNamed(`Save ${BAKERY} epic`)).toBeNull();
  expect(statusOfTheBakery(page)).toBe("");
});

test("an epic whose only change was whitespace leaves no notice when it leaves the page", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_A_HEADING_ONLY_EPIC), EPICS_HASH);
  await page.user.click(editButton(HEADING_ONLY));
  await page.user.type(editor(HEADING_ONLY), "   ");

  await page.refreshWith(SAMPLE_MARKDOWN);

  expect(buttonNamed(`Dismiss the notice about ${HEADING_ONLY} epic`)).toBeNull();
  expect(editButton(COOKBOOK)).toBeTruthy();
});
