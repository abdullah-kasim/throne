import { screen, waitFor } from "@testing-library/react";
import { expect, onTestFinished, test, vi } from "vitest";
import { pageTabs } from "@/features/where-i-stand/page-tabs";
import { FakeBackend, openPage, SAMPLE_MARKDOWN, SAMPLE_RECORDS, startOpeningPage, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const TAB_WIDTH = 100;
const TABS_THAT_FIT = 3;
const TAB_NAMES = ["Now", "Epics", "Queue", "Delivered", "Pull requests"];
const SPELT_MARKDOWN = SAMPLE_MARKDOWN.replace("Order rye flour", "Order spelt flour");
const MARKDOWN_WITH_NOTHING_NEEDING_YOU = `## Needs you

## In flight

### alpha-oven
- Kind: bug fix — Keep the oven warm
`;

const LABELS_WITHOUT_PULL_REQUESTS = ["Now, 3 items, 2 needs you", "Epics, 2 items", "Queue, 1 item", "Delivered, 2 items"];

const countOf = (tab: HTMLElement) => tab.querySelector(".tab-count")?.textContent;
const labelsOf = (page: OpenedPage) => page.tabs().map((tab) => tab.getAttribute("aria-label"));
const highlightOf = (tab: HTMLElement) => tab.querySelector(".tab-needs-you");

test("the page opens on Now showing Needs you, Just happened and In flight", async () => {
  const page = await openPage();

  expect(page.tabs().map((tab) => tab.childNodes[0].textContent)).toEqual(TAB_NAMES);
  expect(page.selectedTabs()).toEqual(["Now"]);
  expect(page.headings(2)).toEqual(["Needs you", "Just happened", "In flight"]);
  expect(page.panel().getAttribute("aria-labelledby")).toBe(page.tab("Now").getAttribute("id"));
});

test("each tab shows only its own sections", async () => {
  const page = await openPage();
  const sectionsOfTab = {
    Epics: ["Epics"],
    Queue: ["Queued and deferred"],
    Delivered: ["Delivered, not on GitHub"],
    "Pull requests": ["Your work", "On GitHub"],
    Now: ["Needs you", "Just happened", "In flight"],
  };

  for (const [words, sections] of Object.entries(sectionsOfTab)) {
    await page.chooseTab(words);
    expect(page.headings(2)).toEqual(sections);
    expect(page.panel().getAttribute("aria-labelledby")).toBe(page.tab(words).getAttribute("id"));
  }
});

test("an unknown hash opens Now", async () => {
  const page = await openPage(new FakeBackend(), "#needs-you");

  expect(page.selectedTabs()).toEqual(["Now"]);
  expect(page.headings(2)).toEqual(["Needs you", "Just happened", "In flight"]);
});

test("a section the tabs do not name stays on Now so nothing on the page is lost", async () => {
  const page = await openPage(new FakeBackend("## Done\n\n### alpha-menu\n- Kind: skill change — Sort\n"));

  expect(page.headings(2)).toEqual(["Done"]);
});

test("the selected tab survives a reload through the hash", async () => {
  const page = await openPage();

  await page.chooseTab("Delivered");

  expect(window.location.hash).toBe("#delivered");
  const reloaded = await openPage(new FakeBackend(), window.location.hash);
  expect(reloaded.selectedTabs()).toEqual(["Delivered"]);
  expect(reloaded.headings(2)).toEqual(["Delivered, not on GitHub"]);
});

test("a hash opens its tab", async () => {
  const page = await openPage(new FakeBackend(), "#delivered");

  expect(page.selectedTabs()).toEqual(["Delivered"]);
  expect(page.headings(2)).toEqual(["Delivered, not on GitHub"]);
});

test("the selected tab stays selected across a refresh", async () => {
  const page = await openPage(new FakeBackend(), "#queue");

  await page.refreshWith(SPELT_MARKDOWN);

  expect(page.headings(2)).toEqual(["Queued and deferred"]);
  expect(page.panel().textContent).toContain("Order spelt flour");
});

test("going back returns to the previous tab", async () => {
  const page = await openPage(new FakeBackend(), "#queue");

  await page.chooseTab("Epics");
  await page.goBack();

  expect(page.selectedTabs()).toEqual(["Queue"]);
  expect(page.headings(2)).toEqual(["Queued and deferred"]);
});

test("changing tab starts the reader at the top and a refresh keeps the scroll position", async () => {
  const page = await openPage();

  await page.chooseTab("Epics");
  expect(page.scrollTo).toHaveBeenCalledTimes(1);
  expect(page.scrollTo).toHaveBeenCalledWith(0, 0);

  page.scrollTo.mockClear();
  await page.refreshWith(SPELT_MARKDOWN);
  expect(page.scrollTo).not.toHaveBeenCalled();
});

function measureTabsInAThreeTabBar() {
  const edges = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function edgesInAThreeTabBar(this: Element) {
    const bar = this.closest<HTMLElement>('[role="tablist"]');
    const position = pageTabs.findIndex(({ name }) => name === this.getAttribute("data-tab-name"));
    const left = position * TAB_WIDTH - (bar?.scrollLeft ?? 0);
    return this === bar ? new DOMRect(0, 0, TAB_WIDTH * TABS_THAT_FIT, 1) : new DOMRect(left, 0, TAB_WIDTH, 1);
  });
  onTestFinished(() => edges.mockRestore());
}

async function openPageWithRecordsOnTheirWay(hash = ""): Promise<OpenedPage> {
  const backend = new FakeBackend();
  backend.holdRecordsReads = true;
  const page = startOpeningPage(backend, hash);
  await waitFor(() => expect(labelsOf(page).slice(0, -1)).toEqual(LABELS_WITHOUT_PULL_REQUESTS));
  await waitFor(() => expect(backend.heldRecordsReads).toHaveLength(1));
  return page;
}

async function answerTheRecords(page: OpenedPage) {
  page.backend.holdRecordsReads = false;
  page.backend.heldRecordsReads.forEach(({ release }) => release());
  await page.settle();
}

test("the selected tab is scrolled inside its bar after its count widens the bar, and a refresh leaves the bar alone", async () => {
  measureTabsInAThreeTabBar();
  const page = await openPage(new FakeBackend(), "#pull-requests");
  const bar = screen.getByRole("tablist");
  expect(countOf(page.tab("Pull requests"))).toBe("3");
  expect(bar.scrollLeft).toBe(TAB_WIDTH * 2);

  bar.scrollLeft = TAB_WIDTH;
  await page.refreshWith(SPELT_MARKDOWN);
  expect(bar.scrollLeft).toBe(TAB_WIDTH);

  await page.chooseTab("Now");
  expect(bar.scrollLeft).toBe(0);
});

test("the Pull requests tab is scrolled inside its bar when its count arrives after the others", async () => {
  measureTabsInAThreeTabBar();
  const page = await openPageWithRecordsOnTheirWay("#pull-requests");
  const bar = screen.getByRole("tablist");
  bar.scrollLeft = 0;

  await answerTheRecords(page);

  expect(bar.scrollLeft).toBe(TAB_WIDTH * 2);
});

test("the Pull requests tab shows no count until the records have answered", async () => {
  const page = await openPageWithRecordsOnTheirWay("#pull-requests");

  expect(labelsOf(page)).toEqual([...LABELS_WITHOUT_PULL_REQUESTS, "Pull requests"]);
  expect(page.tabs().map(countOf)).toEqual(["3", "2", "1", "2", undefined]);
  expect(page.panel().querySelector("table")).toBeNull();
  expect(page.spoilers()).toEqual([]);

  await answerTheRecords(page);

  expect(labelsOf(page)).toEqual([...LABELS_WITHOUT_PULL_REQUESTS, "Pull requests, 3 items"]);
  expect(countOf(page.tab("Pull requests"))).toBe("3");
});

test("a failed read of the records shows no count on the Pull requests tab", async () => {
  const backend = new FakeBackend();
  backend.recordsAnswer = new Response("missing", { status: 404 });
  const page = await openPage(backend, "#pull-requests");

  expect(labelsOf(page)).toEqual([...LABELS_WITHOUT_PULL_REQUESTS, "Pull requests"]);
  expect(page.tabs().map(countOf)).toEqual(["3", "2", "1", "2", undefined]);
  expect(page.panel().textContent).toContain("Could not fetch the pull request records");
});

test("a failed refresh keeps the count of the records still shown", async () => {
  const page = await openPage(new FakeBackend(), "#pull-requests");

  page.backend.recordsAnswer = new Response("missing", { status: 404 });
  await page.refresh();

  expect(page.panel().textContent).toContain("Showing what was last fetched.");
  expect(countOf(page.tab("Pull requests"))).toBe("3");
});

test("each tab shows how many entries it holds", async () => {
  const page = await openPage();

  expect(page.tabs().map(countOf)).toEqual(["3", "2", "1", "2", "3"]);
  expect(page.tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual([
    "Now, 3 items, 2 needs you",
    "Epics, 2 items",
    "Queue, 1 item",
    "Delivered, 2 items",
    "Pull requests, 3 items",
  ]);

  await page.refreshWith(SAMPLE_MARKDOWN.replace("### alpha-flour", "### alpha-flour\n\n### alpha-spelt"));
  expect(countOf(page.tab("Queue"))).toBe("2");
});

test("Now highlights the Needs you count only when something needs you", async () => {
  const page = await openPage();

  expect(highlightOf(page.tab("Now"))?.textContent).toBe("2");
  expect(page.tabs().slice(1).map(highlightOf)).toEqual([null, null, null, null]);

  await page.refreshWith(MARKDOWN_WITH_NOTHING_NEEDING_YOU);
  expect(highlightOf(page.tab("Now"))).toBeNull();
  expect(page.tab("Now").getAttribute("aria-label")).toBe("Now, 1 item");
});

test("arrow keys move between tabs and wrap", async () => {
  const page = await openPage();
  page.tab("Now").focus();

  await page.user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Pull requests"]));
  expect(document.activeElement).toBe(page.tab("Pull requests"));

  await page.user.keyboard("{ArrowRight}");
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Now"]));

  await page.user.keyboard("{ArrowRight}");
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Epics"]));
  expect(document.activeElement).toBe(page.tab("Epics"));

  await page.user.keyboard("{End}");
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Pull requests"]));

  await page.user.keyboard("{Home}");
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Now"]));
});

test("pressing Tab from before the bar lands on the selected tab", async () => {
  const page = await openPage(new FakeBackend(), "#queue");
  const lastLinkBeforeTheBar = screen.getByRole("link", { name: "Where I stand" });
  lastLinkBeforeTheBar.focus();

  await page.user.tab();

  await waitFor(() => expect(document.activeElement).toBe(page.tab("Queue")));
});

test("the browser keeps Alt Left and every other key on the tab bar", async () => {
  const page = await openPage(new FakeBackend(), "#queue");
  page.tab("Queue").focus();

  expect(page.pressOnTabBar("a", 1000)).toBe(false);
  expect(page.pressOnTabBar("d", 3000, { ctrlKey: true })).toBe(false);
  await page.user.keyboard("{Alt>}{ArrowLeft}{/Alt}");

  expect(page.selectedTabs()).toEqual(["Queue"]);
});

test("typing the first letters of a tab moves to that tab", async () => {
  const page = await openPage();
  page.tab("Now").focus();

  page.pressOnTabBar("d", 1000);
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Delivered"]));
  expect(document.activeElement).toBe(page.tab("Delivered"));

  page.pressOnTabBar("e", 1200);
  expect(page.selectedTabs()).toEqual(["Delivered"]);

  page.pressOnTabBar("q", 5000);
  await waitFor(() => expect(page.selectedTabs()).toEqual(["Queue"]));
});

test("going back moves focus from the tab left behind to the selected tab", async () => {
  const page = await openPage(new FakeBackend(), "#queue");
  page.tab("Queue").focus();

  await page.user.keyboard("{ArrowRight}");
  await waitFor(() => expect(document.activeElement).toBe(page.tab("Delivered")));

  await page.goBack();
  expect(document.activeElement).toBe(page.tab("Queue"));
});

test("going back from inside an epic hands focus to the selected tab", async () => {
  const page = await openPage(new FakeBackend(), "#queue");
  await page.chooseTab("Epics");
  screen.getByRole("button", { name: "Edit Open a second bakery epic" }).focus();

  await page.goBack();

  expect(document.activeElement).toBe(page.tab("Queue"));
});

test("throne and dotfiles entries stay collapsed inside the tab they belong to", async () => {
  const page = await openPage();
  expect(page.summaries()).toEqual(["Throne and dotfiles (1, 1 needs you)"]);
  expect(page.spoilers()[0].open).toBe(false);
  expect([...page.spoilers()[0].querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["alpha-bow"]);

  await page.chooseTab("Delivered");
  expect(page.summaries()).toEqual(["Throne and dotfiles (1)"]);
  expect([...page.spoilers()[0].querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["alpha-crown"]);
  expect(page.headings(3)).toContain("alpha-menu");

  await page.chooseTab("Queue");
  expect(page.spoilers()).toEqual([]);
});

test("an open throne and dotfiles block stays open across a refresh and across a change of tab", async () => {
  const page = await openPage();
  page.spoilers()[0].open = true;

  await page.refreshWith(SPELT_MARKDOWN);
  expect(page.spoilers()[0].open).toBe(true);

  await page.chooseTab("Delivered");
  expect(page.spoilers()[0].open).toBe(false);

  await page.chooseTab("Now");
  expect(page.spoilers()[0].open).toBe(true);
});

test("an epic never appears in the Your work table", async () => {
  const page = await openPage(new FakeBackend(), "#pull-requests");
  const workText = page.panel().querySelector(".work")?.textContent;

  expect(workText).toMatch(/Keep the oven warm/);
  expect(workText).not.toMatch(/Open a second bakery|Write the rye cookbook|not a real kind/);

  await page.chooseTab("Epics");
  expect(page.spoilers()).toEqual([]);
  expect(page.headings(3)).toEqual(["Open a second bakery", "Write the rye cookbook"]);
});

test("the page opens at the listener's own root and without a trailing slash", async () => {
  for (const path of ["/where-i-stand/", "/throne/where-i-stand"]) {
    const backend = new FakeBackend();
    const page = await openPage(backend, "#queue", path);
    expect(page.headings(2)).toEqual(["Queued and deferred"]);
    expect(backend.apiAddresses()).toEqual([]);
  }
});

test("the page fetches the stored page and the pull request records and nothing else", async () => {
  const backend = new FakeBackend(SAMPLE_MARKDOWN, SAMPLE_RECORDS);

  await openPage(backend);

  expect([...backend.addresses].sort()).toEqual(["/throne/api/health", "/throne/api/where-i-stand/page", "/throne/api/where-i-stand/records"]);
});
