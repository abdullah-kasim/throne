import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { SAVE_ALREADY_ON_ITS_WAY_WORDS } from "@/features/where-i-stand/page-queries";
import { BAKERY, BAKERY_EPIC, COOKBOOK, editButton, EPIC_CHANGED_WORDS, EPICS_HASH, FakeBackend, openPage, SAMPLE_MARKDOWN, watchAnnouncements, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const SPACED_EPIC = "### Train a new baker\n\nAsk the guild.\n\n- Check the wages";
const MARKDOWN_WITH_A_SPACED_EPIC = `${SAMPLE_MARKDOWN}\n${SPACED_EPIC}\n`;
const NOTHING_TO_SAVE_WORDS = "Nothing to save: this epic is as it was loaded.";
const HEADING_IN_NOTES_WORDS = "Not saved: a notes line starting with ## or ### would start a new section or entry. Use #### or bold text.";

const editor = (title: string) => screen.getByRole<HTMLTextAreaElement>("textbox", { name: `${title} epic` });
const saveButton = (title: string) => screen.getByRole("button", { name: `Save ${title} epic` });
const announcement = () => document.querySelector(".visually-hidden")?.textContent;

function statusOf(title: string): string {
  const heading = screen.getByRole("heading", { level: 3, name: title });
  return heading.closest(".epic")?.querySelector(".unit-status")?.textContent ?? "";
}

async function openEditor(page: OpenedPage, title: string) {
  await page.user.click(editButton(title));
}

async function replaceNotes(page: OpenedPage, title: string, notes: string) {
  await page.user.clear(editor(title));
  await page.user.type(editor(title), notes);
}

test("no editor exists until an epic is opened", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);

  expect(page.panel().querySelector(".epic textarea")).toBeNull();

  await openEditor(page, BAKERY);

  expect(page.panel().querySelectorAll(".epic textarea")).toHaveLength(1);
  expect(editor(BAKERY).value).toBe("Find a street with morning foot traffic.");
  expect(document.activeElement).toBe(editor(BAKERY));
});

test("an epic the Lord did not touch comes back as exactly the Markdown it was loaded from", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_A_SPACED_EPIC), EPICS_HASH);
  await openEditor(page, "Train a new baker");
  editor("Train a new baker").focus();

  await page.user.keyboard("{Control>}s{/Control}");

  expect(page.backend.saveBodies).toEqual([]);
  expect(statusOf("Train a new baker")).toBe("Nothing to save: this epic is as it was loaded.");
  expect(screen.queryByRole("button", { name: "Save Train a new baker epic" })).toBeNull();
});

test("an edited epic keeps its blank lines, its list lines and its heading", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_A_SPACED_EPIC), EPICS_HASH);
  await openEditor(page, "Train a new baker");

  await page.user.type(editor("Train a new baker"), " today");
  await page.user.click(saveButton("Train a new baker"));
  await page.settle();

  expect(page.backend.saveBodies.map(({ row }) => row)).toEqual([{ freeLines: `${SPACED_EPIC} today`.split("\n").slice(1) }]);
});

test("editing shows the unsaved state and undoing the edit clears it", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);

  await page.user.type(editor(BAKERY), "!");
  expect(statusOf(BAKERY)).toBe("Unsaved changes.");
  expect(saveButton(BAKERY)).toBeTruthy();

  await page.user.type(editor(BAKERY), "{Backspace}");
  expect(statusOf(BAKERY)).toBe("");
  expect(screen.queryByRole("button", { name: `Save ${BAKERY} epic` })).toBeNull();
});

test("saving an epic sends its row, its new notes and when it was last changed", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);

  await replaceNotes(page, BAKERY, "Find a site by the harbour.");
  await page.user.click(saveButton(BAKERY));
  await page.settle();

  expect(page.backend.saveBodies).toEqual([{ address: expect.stringMatching(/\/where-i-stand\/store\/rows\/r\d+$/), method: "PUT", writer: "Lord", row: { freeLines: ["Find a site by the harbour."] }, loadedChangedAt: expect.any(String) }]);
  expect(statusOf(BAKERY)).toBe("Saved.");
  expect(editor(BAKERY).value).toBe("Find a site by the harbour.");
});

test("an epic with no notes can be given notes in place", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  const notelessMarkdown = SAMPLE_MARKDOWN.replace("- Kind: throne — not a real kind\n", "");
  await page.refreshWith(notelessMarkdown);
  await openEditor(page, COOKBOOK);
  expect(editor(COOKBOOK).value).toBe("");

  await page.user.type(editor(COOKBOOK), "Ask the guild for an apprentice.");
  await page.user.click(saveButton(COOKBOOK));
  await page.settle();

  expect(page.backend.markdown).toMatch(/### Write the rye cookbook\nAsk the guild for an apprentice\.\n/);
});

test("a refused save says the epic changed and shows the current epic without losing the Lord's text", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "the Lord says ship it");
  page.backend.markdown = SAMPLE_MARKDOWN.replace("morning foot traffic", "evening foot traffic");

  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();

  expect(editor(BAKERY).value).toMatch(/evening foot traffic/);
  expect(statusOf(BAKERY)).toBe(EPIC_CHANGED_WORDS);
  const unsaved = page.panel().querySelector(".unsaved");
  expect(unsaved?.textContent).toMatch(/Your text that was not saved:/);
  expect(unsaved?.textContent).toMatch(/the Lord says ship it/);
});

test("a failed save says so and keeps the text in the editor", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "shipped");
  page.backend.answerToNextSaves = () => Response.json({ outcome: "failed", message: "Not saved: the page could not be written." }, { status: 500 });

  await page.user.click(saveButton(BAKERY));
  await page.settle();
  expect(statusOf(BAKERY)).toBe("Not saved: the page could not be written.");
  expect(editor(BAKERY).value).toBe("shipped");

  page.backend.answerToNextSaves = () => new Response("Bad Gateway", { status: 502 });
  await page.user.click(saveButton(BAKERY));
  await page.settle();
  expect(statusOf(BAKERY)).toMatch(/^Not saved: where-i-stand\/store\/rows\/r\d+ answered 502\.$/);
});

test("a save the backend refuses as outside the Epics section shows its reason", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "shipped");
  const refusal = "Not saved: the page can change only under Epics.";
  page.backend.answerToNextSaves = () => Response.json({ outcome: "refused", message: refusal });

  await page.user.click(saveButton(BAKERY));
  await page.settle();

  expect(statusOf(BAKERY)).toBe(refusal);
  expect(editor(BAKERY).value).toBe("shipped");
});

test("a save says so when the backend cannot be reached", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "shipped");
  page.backend.answerToNextSaves = () => Promise.reject(new TypeError("Failed to fetch"));

  await page.user.click(saveButton(BAKERY));
  await page.settle();

  expect(statusOf(BAKERY)).toBe("Not saved: the backend could not be reached.");
});

test("Cmd or Ctrl S saves the focused epic", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);

  for (const [keys, notes] of [
    ["{Control>}s{/Control}", "by control"],
    ["{Meta>}s{/Meta}", "by command"],
  ]) {
    await replaceNotes(page, BAKERY, notes);
    await page.user.keyboard(keys);
    await page.settle();
    expect(page.backend.saveBodies.at(-1)?.row).toEqual({ freeLines: [notes] });
  }
  expect(page.backend.saveBodies).toHaveLength(2);
});

test("a save is announced once, after the editor has the saved text, with focus still in the epic", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "announced once");
  const region = document.querySelector(".visually-hidden");
  const announced: (string | null | undefined)[] = [];
  const watcher = new MutationObserver(() => announced.push(region?.textContent));
  watcher.observe(region as Element, { childList: true, characterData: true, subtree: true });

  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();
  watcher.disconnect();

  expect(announced).toEqual(["Saving.", "Saved."]);
  expect(document.activeElement).toBe(editor(BAKERY));
});

test("the same status twice is announced twice", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  const announced = watchAnnouncements();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.keyboard("{Control>}s{/Control}");
  await page.settle();

  expect(announced).toEqual([NOTHING_TO_SAVE_WORDS, NOTHING_TO_SAVE_WORDS]);
});

test("a refusal after typing during a save is announced", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "first");
  const answerTheSave = page.backend.holdNextSaves();
  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.keyboard("a");
  const announced = watchAnnouncements();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.keyboard("b");
  await page.user.keyboard("{Control>}s{/Control}");

  expect(announced).toEqual([SAVE_ALREADY_ON_ITS_WAY_WORDS, "Unsaved changes.", SAVE_ALREADY_ON_ITS_WAY_WORDS]);
  answerTheSave();
  await page.settle();
});

test("unsaved text is announced once, not on every key", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  const announced = watchAnnouncements();

  await page.user.keyboard("abc");

  expect(announced).toEqual(["Unsaved changes."]);
});

test("undoing an edit leaves no unsaved words in the status region", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);

  await page.user.keyboard("a");
  await page.user.keyboard("{Backspace}");

  expect(statusOf(BAKERY)).toBe("");
  expect(announcement()).toBe("");
});

test("discarding changes leaves no unsaved words in the status region", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await page.user.keyboard("a");

  await page.user.click(screen.getByRole("button", { name: `Discard changes to ${BAKERY} epic` }));

  expect(announcement()).toBe("");
});

test("pressing save again while a save is on its way sends it only once", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "shipped twice");
  const releaseSave = page.backend.holdNextSaves();

  await page.user.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));
  await page.user.click(saveButton(BAKERY));
  editor(BAKERY).focus();
  await page.user.keyboard("{Control>}s{/Control}");
  releaseSave();
  await page.settle();

  expect(page.backend.saveBodies).toHaveLength(1);
  await waitFor(() => expect(announcement()).toBe("Saved."));
});

test("a Save pressed while a save is on its way says it was not sent", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "first half");
  const answerTheSave = page.backend.holdNextSaves();

  await page.user.click(saveButton(BAKERY));
  await waitFor(() => expect(page.backend.saveBodies).toHaveLength(1));
  await page.user.type(editor(BAKERY), " and second half");
  await page.user.click(saveButton(BAKERY));

  expect(statusOf(BAKERY)).toBe(SAVE_ALREADY_ON_ITS_WAY_WORDS);
  expect(announcement()).toBe(SAVE_ALREADY_ON_ITS_WAY_WORDS);
  expect(saveButton(BAKERY)).toHaveProperty("disabled", false);
  answerTheSave();
  await page.settle();

  expect(page.backend.saveBodies).toHaveLength(1);
  expect(statusOf(BAKERY)).toBe("Unsaved changes.");
});

test("what is typed while a save is on its way stays in the editor as unsaved text", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "first half");
  page.backend.holdPageReads = true;

  await page.user.keyboard("{Control>}s{/Control}");
  await waitFor(() => expect(page.backend.heldPageReads).toHaveLength(1));
  await page.user.type(editor(BAKERY), " and second half");
  page.backend.holdPageReads = false;
  page.backend.heldPageReads.forEach(({ release }) => release());
  await page.settle();

  expect(page.backend.markdown).toContain(`### ${BAKERY}\nfirst half\n`);
  expect(editor(BAKERY).value).toBe("first half and second half");
  expect(saveButton(BAKERY)).toBeTruthy();
});

test("text typed while a save is on its way is not reported as saved", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "first half");
  const answerTheSave = page.backend.holdNextSaves();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.type(editor(BAKERY), " and second half");
  answerTheSave();
  await page.settle();

  expect(statusOf(BAKERY)).toBe("Unsaved changes.");
});

test("text deleted while a save is on its way stays deleted when the save lands", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await page.user.type(editor(BAKERY), "!");
  const answerTheSave = page.backend.holdNextSaves();

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.keyboard("{Backspace}");
  answerTheSave();
  await page.settle();

  expect(page.backend.markdown).toContain(`${BAKERY_EPIC}!\n`);
  expect(editor(BAKERY).value).toBe("Find a street with morning foot traffic.");
  expect(statusOf(BAKERY)).toBe("Unsaved changes.");

  await page.user.click(saveButton(BAKERY));
  await page.settle();
  expect(page.backend.markdown).toContain(`${BAKERY_EPIC}\n`);
  expect(screen.queryByRole("button", { name: `Save ${BAKERY} epic` })).toBeNull();
});

test("text put back to what the file holds during a save that fails leaves nothing to save", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await page.user.type(editor(BAKERY), "!");
  let failTheSave = () => undefined as void;
  const failedAnswer = new Promise<Response>((answer) => {
    failTheSave = () => answer(Response.json({ outcome: "failed", message: "Not saved: the page could not be written." }, { status: 500 }));
  });
  page.backend.answerToNextSaves = () => failedAnswer;

  await page.user.keyboard("{Control>}s{/Control}");
  await page.user.keyboard("{Backspace}");
  failTheSave();
  await page.settle();

  expect(statusOf(BAKERY)).toBe("Not saved: the page could not be written.");
  expect(editor(BAKERY).value).toBe("Find a street with morning foot traffic.");
  expect(screen.queryByRole("button", { name: `Save ${BAKERY} epic` })).toBeNull();
});

test("the page's refresh does not replace an epic the Lord is editing", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "Sell gift cards");
  const openedEditor = editor(BAKERY);

  await page.refreshWith(SAMPLE_MARKDOWN.replace("not a real kind", "a real kind"));

  expect(editor(BAKERY)).toBe(openedEditor);
  expect(openedEditor.value).toBe("Sell gift cards");
  expect(within(page.panel()).getByText(/a real kind/)).toBeTruthy();
});

test("an open editor nobody typed in follows the page on a refresh", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);

  await page.refreshWith(SAMPLE_MARKDOWN.replace("morning foot traffic", "evening foot traffic"));

  expect(editor(BAKERY).value).toBe("Find a street with evening foot traffic.");
});

test("an open editor and its text survive a change of tab", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "Sell gift cards");

  await page.chooseTab("Queue");
  await page.chooseTab("Epics");

  expect(editor(BAKERY).value).toBe("Sell gift cards");
});

test("an open editor coming back with its epic leaves focus where it is", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  const titleField = screen.getByRole("textbox", { name: "Title" });
  await page.user.click(titleField);

  await page.refreshWith(SAMPLE_MARKDOWN.replace(`${BAKERY_EPIC}\n\n`, ""));
  await page.refreshWith(SAMPLE_MARKDOWN);

  expect(editor(BAKERY)).toBeTruthy();
  expect(document.activeElement).toBe(titleField);
});

test("an editor closed and opened again after its epic came back takes focus", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await page.refreshWith(SAMPLE_MARKDOWN.replace(`${BAKERY_EPIC}\n\n`, ""));
  await page.refreshWith(SAMPLE_MARKDOWN);

  await page.user.click(screen.getByRole("button", { name: `Close ${BAKERY} epic` }));
  await openEditor(page, BAKERY);

  expect(document.activeElement).toBe(editor(BAKERY));
});

test("closing an editor keeps focus on the epic and shows the epic again", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);

  await page.user.click(screen.getByRole("button", { name: `Close ${BAKERY} epic` }));

  expect(page.panel().querySelector(".epic textarea")).toBeNull();
  expect(document.activeElement).toBe(editButton(BAKERY));
});

test("discarding changes drops the typed text and saves nothing", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "throw this away");

  await page.user.click(screen.getByRole("button", { name: `Discard changes to ${BAKERY} epic` }));

  expect(page.backend.saveBodies).toEqual([]);
  expect(page.panel().textContent).not.toContain("throw this away");
  expect(page.panel().textContent).toContain("Find a street with morning foot traffic.");
});

test("unsaved text stays visible on every tab when its epic leaves the page", async () => {
  const page = await openPage(new FakeBackend(), EPICS_HASH);
  await openEditor(page, BAKERY);
  await replaceNotes(page, BAKERY, "the Lord says ship it");

  await page.refreshWith(SAMPLE_MARKDOWN.replace(`${BAKERY_EPIC}\n\n`, ""));

  for (const words of ["Now", "Epics", "Queue", "Delivered", "Pull requests"]) {
    await page.chooseTab(words);
    expect(screen.getByText("the Lord says ship it")).toBeTruthy();
  }

  await page.user.click(screen.getByRole("button", { name: /^Dismiss/ }));
  expect(screen.queryByText("the Lord says ship it")).toBeNull();
});
