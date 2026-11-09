import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SAVE_ALREADY_ON_ITS_WAY_WORDS } from "@/features/where-i-stand/save-page-unit";
import { BAKERY, BAKERY_EPIC, COOKBOOK, editButton, EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const HARBOUR = "Bake for the harbour";
const MARKDOWN_WITH_THREE_EPICS = `${SAMPLE_MARKDOWN}\n### ${HARBOUR}\n`;
const MARKDOWN_WITH_ONE_EPIC = "## In flight\n\n### alpha-oven\n- Kind: fix\n\n## Epics\n\n### Open a second bakery\n";
const NOW_LINK_ENTRY = /### alpha-giftcard\n[^]*?\n\n/;

const removeButton = (title: string) => screen.getByRole("button", { name: `Remove ${title} epic` });
const notesBox = (title: string) => screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${title} epic` });
const titleField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Title" });

async function askToRemove(page: OpenedPage, title: string) {
  await page.user.click(removeButton(title));
  return screen.findByRole("alertdialog");
}

async function openPageWithUnsavedText(): Promise<OpenedPage> {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  await page.user.type(screen.getByRole("textbox", { name: `${BAKERY} epic` }), " by the harbour");
  return page;
}

async function confirmRemoval(page: OpenedPage, title: string) {
  await askToRemove(page, title);
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));
  await page.settle();
}

async function startHeldRemoval(page: OpenedPage, title: string) {
  const answerTheRemoval = page.backend.holdNextSaves();
  await askToRemove(page, title);
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));
  return answerTheRemoval;
}

async function removeWithFocusBackOnItsButton(page: OpenedPage, title: string) {
  const answerTheRemoval = await startHeldRemoval(page, title);
  await waitFor(() => expect(document.activeElement).toBe(removeButton(title)));
  answerTheRemoval();
  await page.settle();
}

test("removing an epic that gained lines since it was read refuses and leaves them where they are", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const gained = `${BAKERY_EPIC}\n\nThe lease is signed.`;
  page.backend.markdown = page.backend.markdown.replace(BAKERY_EPIC, gained);

  await confirmRemoval(page, BAKERY);

  expect(page.backend.markdown).toContain(gained);
  expect(screen.getByRole("heading", { level: 3, name: BAKERY }).closest(".epic")?.textContent).toContain("Not saved: this entry changed since the page loaded");
  expect(page.panel().textContent).toContain("The lease is signed.");

  await confirmRemoval(page, BAKERY);

  expect(page.backend.markdown).not.toContain("The lease is signed.");
  expect(page.backend.markdown).not.toContain(BAKERY);
});

function animateTheQuestionClosing(): () => void {
  const computedStyleOf = window.getComputedStyle.bind(window);
  const styleOfClosingQuestion = (style: CSSStyleDeclaration, question: Element) =>
    new Proxy(style, {
      get(target, property) {
        if (property === "animationName") return question.getAttribute("data-state") === "closed" ? "closing" : "none";
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const animated = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElement) => {
    const style = computedStyleOf(element, pseudoElement);
    return element.getAttribute("role") === "alertdialog" ? styleOfClosingQuestion(style, element) : style;
  });
  return () => animated.mockRestore();
}

test("removing an epic asks first, naming the epic", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  const dialog = await askToRemove(page, BAKERY);

  expect(dialog.textContent).toContain(`Remove epic '${BAKERY}'?`);
  expect(page.backend.saveBodies).toEqual([]);
});

test("cancelling the confirmation leaves the epic untouched", async () => {
  const page = await openPageWithUnsavedText();

  await askToRemove(page, BAKERY);
  await page.user.click(screen.getByRole("button", { name: "Keep epic" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

  expect(page.backend.saveBodies).toEqual([]);
  expect(page.backend.markdown).toBe(SAMPLE_MARKDOWN);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${BAKERY} epic` }).value).toContain("by the harbour");
  expect(screen.getByRole("button", { name: `Save ${BAKERY} epic` })).toBeTruthy();
});

test("accepting the confirmation removes the epic through the save", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await confirmRemoval(page, BAKERY);

  expect(page.backend.saveBodies).toEqual([{ loaded: BAKERY_EPIC, edited: "" }]);
  expect(page.backend.markdown).not.toContain(BAKERY);
  expect(page.headings(3)).toEqual([COOKBOOK]);
  expect(document.querySelector(".visually-hidden")?.textContent).toBe("Saved.");
});

test("removing an epic with unsaved text leaves no notice behind", async () => {
  const page = await openPageWithUnsavedText();

  await confirmRemoval(page, BAKERY);

  expect(screen.queryByText(/your text was not saved/)).toBeNull();
});

test("focus after a removal moves to the epic beside the removed one", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await removeWithFocusBackOnItsButton(page, BAKERY);

  await waitFor(() => expect(document.activeElement).toBe(editButton(COOKBOOK)));
});

test("focus after removing the last epic in the list moves to the one before it", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  await removeWithFocusBackOnItsButton(page, COOKBOOK);

  await waitFor(() => expect(document.activeElement).toBe(editButton(BAKERY)));
});

test("removing the only epic hands focus to the selected tab", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_ONE_EPIC), EPICS_HASH);

  await removeWithFocusBackOnItsButton(page, BAKERY);

  await waitFor(() => expect(document.activeElement).toBe(page.tab("Epics")));
});

test("a removal is announced after focus has moved, so the move cannot cut it off", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);
  await waitFor(() => expect(document.activeElement).toBe(removeButton(BAKERY)));
  const region = document.querySelector(".visually-hidden") as Element;
  const focusWhenAnnounced: (Element | null)[] = [];
  new MutationObserver(() => focusWhenAnnounced.push(document.activeElement)).observe(region, { childList: true });

  answerTheRemoval();
  await page.settle();

  expect(region.textContent).toBe("Saved.");
  expect(focusWhenAnnounced).toEqual([editButton(COOKBOOK)]);
});

test("a refused removal says why, keeps the epic and keeps focus on its remove button", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const refusal = "Not saved: the page's edit lock is held by alpha-oven; save again once it is released.";
  page.backend.answerToNextSaves = () => Response.json({ outcome: "lock-held", message: refusal }, { status: 409 });

  await confirmRemoval(page, BAKERY);

  expect(page.headings(3)).toContain(BAKERY);
  expect(page.panel().querySelector(".epic .unit-status")?.textContent).toBe(refusal);
  expect(document.activeElement).toBe(removeButton(BAKERY));
});

test("while notes are saving their epic offers neither removal nor discarding, and offers them again after the answer", async () => {
  const page = await openPageWithUnsavedText();
  const discardButton = () => screen.getByRole<HTMLButtonElement>("button", { name: `Discard changes to ${BAKERY} epic` });
  const answerTheSave = page.backend.holdNextSaves();

  await page.user.click(screen.getByRole("button", { name: `Save ${BAKERY} epic` }));

  expect(removeButton(BAKERY)).toHaveProperty("disabled", true);
  expect(discardButton()).toHaveProperty("disabled", true);
  await page.user.click(removeButton(BAKERY));
  expect(screen.queryByRole("alertdialog")).toBeNull();

  answerTheSave();
  await page.settle();

  expect(removeButton(BAKERY)).toHaveProperty("disabled", false);
});

test("a removal on its way leaves the remove button able to take focus back", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRemoval = page.backend.holdNextSaves();

  await askToRemove(page, BAKERY);
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));

  expect(removeButton(BAKERY)).toHaveProperty("disabled", false);
  answerTheRemoval();
  await page.settle();
});

test("Cmd or Ctrl S in the removal question saves nothing, so the removal still goes through", async () => {
  const page = await openPageWithUnsavedText();

  await askToRemove(page, BAKERY);
  await page.user.keyboard("{Control>}s{/Control}");

  expect(page.backend.saveBodies).toEqual([]);
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));
  await page.settle();
  expect(page.headings(3)).not.toContain(BAKERY);
});

test("a removal's late answer leaves focus alone when the Lord has moved on", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);

  await page.user.type(titleField(), "abc");
  answerTheRemoval();
  await page.settle();

  expect(page.headings(3)).toEqual([COOKBOOK]);
  expect(document.activeElement).toBe(titleField());
  await page.user.keyboard("def");
  expect(titleField().value).toBe("abcdef");
});

test("a removal's late answer leaves focus on the body when the Lord clicked away", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);

  (document.activeElement as HTMLElement).blur();
  answerTheRemoval();
  await page.settle();

  expect(page.headings(3)).toEqual([COOKBOOK]);
  expect(document.activeElement).toBe(document.body);
});

test("focus left in the notes box of a removed epic moves to the epic beside it", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);

  await page.user.click(notesBox(BAKERY));
  answerTheRemoval();
  await page.settle();

  await waitFor(() => expect(document.activeElement).toBe(editButton(COOKBOOK)));
});

test("the notes box takes no text while its epic is being removed", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  const notesWhenAsked = notesBox(BAKERY).value;
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);

  await page.user.click(notesBox(BAKERY));
  await page.user.keyboard("lost words");

  expect(notesBox(BAKERY).value).toBe(notesWhenAsked);
  expect(document.activeElement).toBe(notesBox(BAKERY));
  answerTheRemoval();
  await page.settle();
});

test("an editor closed and opened again during a removal still takes no text", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  const notesWhenAsked = notesBox(BAKERY).value;
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);

  await page.user.click(screen.getByRole("button", { name: `Close ${BAKERY} epic` }));
  await page.user.click(editButton(BAKERY));
  await page.user.keyboard("lost words");

  expect(notesBox(BAKERY).value).toBe(notesWhenAsked);
  answerTheRemoval();
  await page.settle();
});

test("a removal that fails gives the notes box back", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(BAKERY));
  page.backend.answerToNextSaves = () => Response.json({ outcome: "lock-held", message: "Not saved: the page's edit lock is held." }, { status: 409 });

  await confirmRemoval(page, BAKERY);
  await page.user.type(notesBox(BAKERY), " kept");

  expect(notesBox(BAKERY).value).toContain(" kept");
});

test("a removal confirmed again while it is on its way says it was not sent", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);

  await askToRemove(page, BAKERY);
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));

  expect(page.panel().querySelector(".epic .unit-status")?.textContent).toBe(SAVE_ALREADY_ON_ITS_WAY_WORDS);
  answerTheRemoval();
  await page.settle();

  expect(page.backend.saveBodies).toHaveLength(1);
});

test("an epic vanishing after a failed removal hands focus to the selected tab, not the epic beside it", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  page.backend.answerToNextSaves = () => Response.json({ outcome: "lock-held", message: "Not saved: the page's edit lock is held." }, { status: 409 });
  await confirmRemoval(page, BAKERY);
  await waitFor(() => expect(document.activeElement).toBe(removeButton(BAKERY)));

  await page.refreshWith(SAMPLE_MARKDOWN.replace(BAKERY_EPIC, ""));

  await waitFor(() => expect(document.activeElement).toBe(page.tab("Epics")));
});

test("an epic vanishing after a removal has landed hands focus to the selected tab, not the epic beside the removal", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_THREE_EPICS), EPICS_HASH);
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);
  await page.user.click(titleField());
  answerTheRemoval();
  await page.settle();
  editButton(HARBOUR).focus();

  await page.refreshWith(page.backend.markdown.replace(`### ${HARBOUR}\n`, ""));

  await waitFor(() => expect(document.activeElement).toBe(page.tab("Epics")));
});

test("a removal landing while its neighbour saves puts focus on a control that can take it", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await page.user.click(editButton(COOKBOOK));
  await page.user.type(notesBox(COOKBOOK), " in rye");
  const answerTheSave = page.backend.holdNextSaves();
  await page.user.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));

  const answerTheRemoval = page.backend.holdNextSaves();
  await askToRemove(page, BAKERY);
  await page.user.click(screen.getByRole("button", { name: "Remove epic" }));
  await waitFor(() => expect(document.activeElement).toBe(removeButton(BAKERY)));
  answerTheRemoval();

  await waitFor(() => expect(page.headings(3)).toEqual([COOKBOOK]));
  await waitFor(() => expect(document.activeElement).toBe(page.tab("Epics")));
  answerTheSave();
  await page.settle();
});

test("focus leaving a control on another tab during a removal stays out of the hidden Epics panel", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const answerTheRemoval = await startHeldRemoval(page, BAKERY);
  await page.chooseTab("Now");
  within(page.panel()).getAllByRole("link")[0].focus();

  page.backend.markdown = page.backend.markdown.replace(NOW_LINK_ENTRY, "");
  await act(async () => {
    window.dispatchEvent(new Event("visibilitychange"));
  });

  await waitFor(() => expect(document.activeElement).toBe(page.tab("Now")));
  answerTheRemoval();
  await page.settle();
});

test("going back with the removal question open closes it, sends nothing and leaves focus on a control", async () => {
  const page = await openPage();
  await page.chooseTab("Epics");
  await askToRemove(page, BAKERY);

  await page.goBack();

  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(page.tab("Now")));
  expect(page.backend.saveBodies).toEqual([]);
  expect(page.backend.markdown).toContain(BAKERY);
});

test("Remove epic pressed while the question closes after going back sends nothing", async () => {
  const stopAnimating = animateTheQuestionClosing();
  const page = await openPage();
  await page.chooseTab("Epics");
  await askToRemove(page, BAKERY);

  await page.goBack();
  await page.user.click(screen.getByRole("button", { name: "Remove epic", hidden: true }));
  stopAnimating();

  expect(page.backend.saveBodies).toEqual([]);
});

test("coming forward again does not bring the removal question back", async () => {
  const page = await openPage();
  await page.chooseTab("Epics");
  await askToRemove(page, BAKERY);
  await page.goBack();
  await waitFor(() => expect(document.activeElement).toBe(page.tab("Now")));

  await page.goForward();

  await waitFor(() => expect(page.selectedTabs()).toEqual(["Epics"]));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(page.tab("Epics"));
});
