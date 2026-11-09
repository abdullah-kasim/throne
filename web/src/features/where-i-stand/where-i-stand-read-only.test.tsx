import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FakeBackend, openPage, SAMPLE_MARKDOWN } from "@/features/where-i-stand/where-i-stand.test-support";

const PREVIEW_ADDRESS = "https://forge.example.com/shop/storefront/pulls/8";
const RECIPE_ADDRESS = "https://recipes.example.com/rye";
const MARKDOWN_WITH_INLINE_TEXT = `## Needs you

### alpha-giftcard
- Where it stands: see [the preview](${PREVIEW_ADDRESS}) and ${RECIPE_ADDRESS}, run \`npm test\`, **waiting** on you
- Verified: the recipe at <${RECIPE_ADDRESS}> bakes 2 \\* 6 loaves
- Opened with [a bad link](javascript:alert)

## In flight

### alpha-oven
First line of the note.
Second line of the note.
`;

const ENTRY_NAMES_OF_A_LONG_SECTION = Array.from({ length: 30 }, (_, index) => `alpha-oven-${index + 1}`);
const MARKDOWN_WITH_A_LONG_SECTION = `## In flight\n\n${ENTRY_NAMES_OF_A_LONG_SECTION.map((name) => `### ${name}\n- Where it stands: baking`).join("\n\n")}\n`;

const TABS_WITHOUT_EDITING = ["Now", "Queue", "Delivered", "Pull requests"];

test("no tab but Epics offers an edit, save or remove control", async () => {
  const page = await openPage();

  for (const words of TABS_WITHOUT_EDITING) {
    await page.chooseTab(words);
    expect(within(page.panel()).queryAllByRole("button")).toEqual([]);
    expect(within(page.panel()).queryAllByRole("textbox")).toEqual([]);
    expect(page.panel().querySelector("[contenteditable]")).toBeNull();
  }
});

test("the section headings and entry headings cannot be edited", async () => {
  const page = await openPage(new FakeBackend(), "#epics");

  await page.user.click(screen.getByRole("button", { name: "Edit Open a second bakery epic" }));

  expect(within(page.panel()).getByRole("heading", { level: 3, name: "Open a second bakery" }).closest("textarea, [contenteditable]")).toBeNull();
  expect(within(page.panel()).getByRole("heading", { level: 2, name: "Epics" }).closest("textarea, [contenteditable]")).toBeNull();
});

test("an entry shows its links, bare addresses, inline code and bold", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_INLINE_TEXT));
  const links = within(page.panel()).getAllByRole("link");

  expect(links.map((link) => link.getAttribute("href"))).toEqual([PREVIEW_ADDRESS, RECIPE_ADDRESS, RECIPE_ADDRESS]);
  expect(links[0].getAttribute("rel")).toBe("noreferrer");
  expect(page.panel().querySelector("code")?.textContent).toBe("npm test");
  expect(page.panel().querySelector("strong")?.textContent).toBe("waiting");
  expect(page.panel().textContent).toContain("bakes 2 * 6 loaves");
  expect(page.panel().textContent).toContain("Opened with a bad link");
});

test("a section longer than the first screen ends up showing every entry in order", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_A_LONG_SECTION));

  await within(page.panel()).findByRole("heading", { level: 3, name: ENTRY_NAMES_OF_A_LONG_SECTION.at(-1) });

  const headings = within(page.panel()).getAllByRole("heading", { level: 3 });
  expect(headings.map((heading) => heading.textContent)).toEqual(ENTRY_NAMES_OF_A_LONG_SECTION);
});

test("each line of a note stays its own line", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_WITH_INLINE_TEXT));

  expect(page.panel().textContent).toContain("First line of the note.\nSecond line of the note.");
});

test("Cmd or Ctrl S never opens the browser's own save on a read-only tab", async () => {
  const page = await openPage();
  const pressed = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true, bubbles: true });

  document.body.dispatchEvent(pressed);

  expect(pressed.defaultPrevented).toBe(true);
  expect(page.backend.saveBodies).toEqual([]);
  expect(SAMPLE_MARKDOWN).toBe(page.backend.markdown);
});
