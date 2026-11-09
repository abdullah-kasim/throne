import { expect, test } from "vitest";
import { FakeBackend, openPage, recordsWith, workRecord, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const PULL_REQUESTS_HASH = "#pull-requests";
const THRONE_FORGEJO_ADDRESS = "https://forge.example.com/court/throne-mirror/pulls/3";
const DOTFILES_GITHUB_ADDRESS = "https://github.com/court/dotfiles/pull/9";
const GIFT_CARD_FORGEJO_ADDRESS = "https://forge.example.com/shop/storefront/pulls/8";
const THRONE_AND_DOTFILES_SUMMARY = "Throne and dotfiles";
const ENTRIES_MOVED_WORDS = "Moved to Throne and dotfiles, at the foot of this tab.";
const MARKDOWN_NEEDING_ONLY_THRONE_WORK = `## Needs you

### alpha-bow
- Links: Forgejo ${THRONE_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: throne — Teach the court to bow

## In flight

### alpha-prompt
- Links: no pull request · not started · Ticket no ticket
- Kind: dotfiles — Colour the shell prompt
`;

const RECORDS = recordsWith({
  rows: [
    workRecord({ group: "Waiting on review", title: "Fix the basket total rounding", forgejo: { url: "https://forge.example.com/shop/storefront/pulls/7", number: 7, state: "open" } }),
    workRecord({ group: "Forgejo only", title: "Add a gift card page", forgejo: { url: GIFT_CARD_FORGEJO_ADDRESS, number: 8, state: "draft" } }),
    workRecord({ group: "Forgejo only", repository: "court/throne-mirror", title: "Teach the court to bow", forgejo: { url: THRONE_FORGEJO_ADDRESS, number: 3, state: "open" } }),
    workRecord({ group: "Waiting on review", repository: "court/dotfiles", title: "Shorter shell prompt", github: { url: DOTFILES_GITHUB_ADDRESS, number: 9, state: "ready" } }),
    workRecord({ group: "Forgejo only", repository: "court/practice-throne-oven", title: "Try the forge", forgejo: { url: "https://forge.example.com/court/practice-throne-oven/pulls/1", number: 1, state: "open" } }),
  ],
});

const MARKDOWN = `## Needs you

### alpha-bow
- Links: Forgejo ${THRONE_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new feature — Teach the court to bow
- Where it stands: waiting for your word

### alpha-giftcard
- Links: Forgejo ${GIFT_CARD_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — Add a gift card page

## In flight

### alpha-connectors
- Links: no pull request · throne main 1a2b3c4d · Ticket no ticket
- Kind: fix — Keep the connectors

### alpha-prompt
- Links: no pull request · not started · Ticket no ticket
- Kind: dotfiles — Colour the shell prompt

### alpha-oven
- Links: no pull request · local main 5e6f7a8b · Ticket no ticket
- Kind: change — Warm the oven earlier

## Done
`;

function titlesIn(container: Element): string[] {
  return [...container.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1].children[1].textContent);
}

function workSpoiler(page: OpenedPage): HTMLDetailsElement {
  return page.spoilers()[0];
}

function mainTableTitles(page: OpenedPage): string[] {
  const mainTable = page.panel().querySelector(".work > table");
  return mainTable === null ? [] : titlesIn(mainTable);
}

const openWorkPage = (markdown = MARKDOWN, records: unknown = RECORDS) => openPage(new FakeBackend(markdown, records), PULL_REQUESTS_HASH);

test("throne and dotfiles pull requests move out of the main work table into a collapsed section", async () => {
  const page = await openWorkPage("## Done\n");

  expect(titlesIn(workSpoiler(page))).toEqual(["Teach the court to bow", "Shorter shell prompt"]);
  expect(page.summaries()[0]).toBe(`${THRONE_AND_DOTFILES_SUMMARY} (2)`);
  expect(mainTableTitles(page)).toEqual(["Fix the basket total rounding", "Add a gift card page", "Try the forge"]);
});

test("a failed read of the records takes the row count out of the summary and keeps what needs the Lord", async () => {
  const backend = new FakeBackend(MARKDOWN, RECORDS);
  backend.recordsAnswer = new Response("missing", { status: 404 });
  const page = await openPage(backend, PULL_REQUESTS_HASH);

  expect(page.summaries()[0]).toBe(`${THRONE_AND_DOTFILES_SUMMARY} (1 needs you)`);

  await page.refreshWith(MARKDOWN.replace("## Needs you", "## In flight, again"));
  expect(page.summaries()[0]).toBe(THRONE_AND_DOTFILES_SUMMARY);
});

test("a Needs you card whose entries all sit in the spoiler says where they are", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN_NEEDING_ONLY_THRONE_WORK, RECORDS));
  const card = () => page.panel().querySelector(".needs-you");

  expect(card()?.textContent).toBe(`Needs you${ENTRIES_MOVED_WORDS}`);
  expect(card()?.querySelectorAll("a, button, summary")).toHaveLength(0);
  expect(page.panel().textContent?.split(ENTRIES_MOVED_WORDS)).toHaveLength(2);

  await page.refreshWith(MARKDOWN);
  expect(card()?.textContent).not.toContain(ENTRIES_MOVED_WORDS);

  await page.refreshWith("## Needs you\n");
  expect(card()?.textContent).toBe("Needs you");
});

test("a dotfiles entry with no pull request is sorted by its Kind line", async () => {
  const page = await openWorkPage();

  expect(titlesIn(workSpoiler(page))).toContain("Colour the shell prompt");
  expect(mainTableTitles(page)).not.toContain("Colour the shell prompt");
});

test("a no-pull-request entry whose commit names the throne repository is sorted with throne work", async () => {
  const page = await openWorkPage();

  expect(titlesIn(workSpoiler(page))).toContain("Keep the connectors");
  expect(mainTableTitles(page)).not.toContain("Keep the connectors");
});

test("work for other repositories stays in the main work table", async () => {
  const page = await openWorkPage();

  expect(mainTableTitles(page)).toEqual(["Fix the basket total rounding", "Add a gift card page", "Try the forge", "Warm the oven earlier"]);
});

test("a throne entry that needs the Lord is counted in the collapsed section's summary", async () => {
  const page = await openWorkPage();

  expect(titlesIn(workSpoiler(page))).toEqual(["Teach the court to bow", "Shorter shell prompt", "Keep the connectors", "Colour the shell prompt"]);
  expect(page.summaries()[0]).toBe(`${THRONE_AND_DOTFILES_SUMMARY} (4, 1 needs you)`);

  await page.chooseTab("Now");
  expect(page.summaries()[0]).toBe(`${THRONE_AND_DOTFILES_SUMMARY} (3, 1 needs you)`);
});

test("throne and dotfiles entries move out of their sections into one collapsed section that names where each came from", async () => {
  const page = await openPage(new FakeBackend(MARKDOWN, RECORDS));
  const sections = [...page.panel().querySelectorAll("section")];
  const textsIn = (container: Element, selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent);

  expect(sections.map((section) => textsIn(section, "h2"))).toEqual([["Needs you"], ["In flight"], ["Done"], []]);
  expect(sections.slice(0, 3).map((section) => textsIn(section, "h3"))).toEqual([["alpha-giftcard"], ["alpha-oven"], []]);
  const [spoiler] = page.spoilers();
  expect(textsIn(spoiler, "h3")).toEqual(["alpha-bow", "alpha-connectors", "alpha-prompt"]);
  expect(textsIn(spoiler, "div > p:first-child")).toEqual(["Section: Needs you", "Section: In flight", "Section: In flight"]);
  expect(sections[0].classList.contains("needs-you")).toBe(true);
});

test("the throne and dotfiles sections are collapsed when the page opens", async () => {
  const page = await openWorkPage();

  expect(page.spoilers().map((spoiler) => spoiler.open)).toEqual([false]);
  await page.chooseTab("Now");
  expect(page.spoilers().map((spoiler) => spoiler.open)).toEqual([false]);
});

test("a throne and dotfiles section the Lord opened stays open when the page refreshes", async () => {
  const page = await openWorkPage();
  workSpoiler(page).open = true;

  await page.refreshWith(`${MARKDOWN}\n- Baked the first loaf.\n`);

  expect(workSpoiler(page).open).toBe(true);
});

test("a no-pull-request entry whose address ends in .git is sorted with throne and dotfiles work", async () => {
  const markdown = `## In flight\n\n### alpha-clone\n- Links: no pull request · https://github.com/court/dotfiles.git main cece0c80 · Ticket no ticket\n- Kind: change — Clone the dotfiles\n`;

  const page = await openWorkPage(markdown, recordsWith());

  expect(titlesIn(workSpoiler(page))).toEqual(["Clone the dotfiles"]);
});

test("a throne and dotfiles section that empties and fills again comes back collapsed", async () => {
  const page = await openWorkPage();
  workSpoiler(page).open = true;

  page.backend.records = recordsWith();
  await page.refreshWith("## Done\n");
  expect(page.spoilers()).toEqual([]);

  page.backend.records = RECORDS;
  await page.refreshWith(MARKDOWN);
  expect(workSpoiler(page).open).toBe(false);
});
