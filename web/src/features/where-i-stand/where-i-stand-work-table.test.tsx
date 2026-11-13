import { expect, test } from "vitest";
import { FakeBackend, openPage, recordsWith, workRecord, type OpenedPage } from "@/features/where-i-stand/where-i-stand.test-support";

const PULL_REQUESTS_HASH = "#pull-requests";
const MINUTES_SINCE_THE_RECORDS_WERE_READ = 5;
const STOREFRONT_FORGEJO_ADDRESS = "https://forge.example.com/shop/storefront/pulls/7";
const STOREFRONT_GITHUB_ADDRESS = "https://github.com/shop/storefront/pull/41";
const STOREFRONT_TICKET_ADDRESS = "https://tracker.example.com/ABC-12";
const GIFT_CARD_FORGEJO_ADDRESS = "https://forge.example.com/shop/storefront/pulls/8";
const BASKET_TOUR_ADDRESS = "https://videos.example.com/basket-tour.mp4";
const BASKET_TITLE = "Fix the basket total rounding";
const GIFT_CARD_TITLE = "Add a gift card page";

const STOREFRONT_RECORD = workRecord({
  group: "Waiting on review",
  title: BASKET_TITLE,
  ticket: "ABC-12",
  ticket_url: STOREFRONT_TICKET_ADDRESS,
  kind: "bug fix",
  forgejo: { url: STOREFRONT_FORGEJO_ADDRESS, number: 7, state: "open" },
  github: { url: STOREFRONT_GITHUB_ADDRESS, number: 41, state: "ready, CI green" },
  head_commits: "GitHub behind Forgejo",
});

const GIFT_CARD_RECORD = workRecord({ group: "Forgejo only", title: GIFT_CARD_TITLE, forgejo: { url: GIFT_CARD_FORGEJO_ADDRESS, number: 8, state: "draft" } });

const SAMPLE_RECORDS = recordsWith({
  read_at: new Date(Date.now() - MINUTES_SINCE_THE_RECORDS_WERE_READ * 60000).toISOString(),
  problems: ["forge.example.com: the server answered 502"],
  changes: [`new: [storefront #41](${STOREFRONT_GITHUB_ADDRESS}): waiting on review (ready, CI green)`],
  rows: [STOREFRONT_RECORD, GIFT_CARD_RECORD],
});

const SAMPLE_MARKDOWN = `## Needs you

### alpha-giftcard
- Links: Forgejo ${GIFT_CARD_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — ${GIFT_CARD_TITLE}
- Where it stands: waiting for your look at the preview
- Verified: the page opens on a phone

### stager-tour
- Links: no pull request · ${BASKET_TOUR_ADDRESS} · Ticket ABC-12
- Kind: explainer video — Basket tour
- Where it stands: rendered, waiting for your review

## Done

### alpha-menu
- Links: no pull request · \`a1b2c3d\` · Ticket no ticket
- Kind: skill change — Teach the menu skill to sort
- Where it stands: on local main

### regent
- Restarted the bakery's backend.
`;

const WORK_TITLES = ["Basket tour", BASKET_TITLE, GIFT_CARD_TITLE, "Teach the menu skill to sort", "regent"];

function workSection(page: OpenedPage): Element {
  const section = page.panel().querySelector(".work");
  if (section === null) throw new Error("the page shows the work section");
  return section;
}

function tableRows(page: OpenedPage): Element[][] {
  return [...workSection(page).querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")]);
}

function linesOf(cell: Element): string[] {
  return [...cell.children].map((line) => line.textContent);
}

function linksOf(cell: Element): Record<string, string | null> {
  return Object.fromEntries([...cell.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]));
}

function rowTitled(page: OpenedPage, title: string): Element[] {
  const row = tableRows(page).find((cells) => linesOf(cells[1]).includes(title));
  if (row === undefined) throw new Error(`a row is titled ${title}`);
  return row;
}

function titlesOf(page: OpenedPage): string[] {
  return tableRows(page).map((cells) => linesOf(cells[1])[1]);
}

const openSamplePage = (markdown = SAMPLE_MARKDOWN, records: unknown = SAMPLE_RECORDS) => openPage(new FakeBackend(markdown, records), PULL_REQUESTS_HASH);

test("the where-i-stand table gives each piece of work its Forgejo, GitHub and ticket links in one column", async () => {
  const [links] = rowTitled(await openSamplePage(), BASKET_TITLE);

  expect(linksOf(links)).toEqual({
    "Forgejo #7": STOREFRONT_FORGEJO_ADDRESS,
    "GitHub #41": STOREFRONT_GITHUB_ADDRESS,
    "Ticket ABC-12": STOREFRONT_TICKET_ADDRESS,
  });
  expect(links.getAttribute("data-label")).toBe("Links");
});

test("the where-i-stand table writes a short word for a missing link instead of leaving it blank", async () => {
  const page = await openSamplePage();

  expect(linesOf(rowTitled(page, GIFT_CARD_TITLE)[0])).toEqual(["Forgejo #8", "not on GitHub yet", "no ticket"]);
  expect(linesOf(rowTitled(page, "regent")[0])).toEqual(["no Forgejo copy", "not on GitHub yet", "no ticket"]);
});

test("the where-i-stand table says what sort of work each row is and where it stands", async () => {
  const page = await openSamplePage();
  const [, kind, whereItStands] = rowTitled(page, BASKET_TITLE);

  expect(linesOf(kind)).toEqual(["bug fix", BASKET_TITLE]);
  expect(linesOf(whereItStands)).toEqual(["Waiting on review; Forgejo open; GitHub ready, CI green; GitHub behind Forgejo"]);
  expect(linesOf(rowTitled(page, "regent")[1])).toEqual(["kind not stated", "regent"]);
});

test("the where-i-stand table gives work without a pull request a row from the agents' entry", async () => {
  const page = await openSamplePage();
  const [tourLinks, tourKind, tourStands] = rowTitled(page, "Basket tour");

  expect(linesOf(tourLinks)).toEqual(["no pull request", BASKET_TOUR_ADDRESS, "ABC-12"]);
  expect(linksOf(tourLinks)).toEqual({ [BASKET_TOUR_ADDRESS]: BASKET_TOUR_ADDRESS });
  expect(linesOf(tourKind)).toEqual(["explainer video", "Basket tour"]);
  expect(linesOf(tourStands)).toEqual(["Needs you", "rendered, waiting for your review"]);
  expect(linesOf(rowTitled(page, "Teach the menu skill to sort")[0])).toEqual(["no pull request", "a1b2c3d", "no ticket"]);
});

test("the where-i-stand table merges an agent's entry into the row for the same pull request", async () => {
  const page = await openSamplePage();
  const [, kind, whereItStands] = rowTitled(page, GIFT_CARD_TITLE);

  expect(linesOf(kind)).toEqual(["new page", GIFT_CARD_TITLE]);
  expect(linesOf(whereItStands)).toEqual(["Forgejo only; Forgejo draft", "waiting for your look at the preview"]);
  expect(titlesOf(page)).toEqual(WORK_TITLES);
});

test("the where-i-stand page says when the records were read and names a host that could not be read", async () => {
  const page = await openSamplePage();

  expect(workSection(page).textContent).toMatch(new RegExp(`Pull requests read .+, ${MINUTES_SINCE_THE_RECORDS_WERE_READ} minutes ago\\.`));
  expect([...workSection(page).querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "Could not read: forge.example.com: the server answered 502",
    "new: storefront #41: waiting on review (ready, CI green)",
  ]);
});

test("the where-i-stand page shows the changes since the last refresh", async () => {
  const page = await openSamplePage();

  expect(workSection(page).querySelector("h3")?.textContent).toBe("Changed since the last refresh");
  expect(workSection(page).querySelectorAll("ul")[1].querySelector("a")?.getAttribute("href")).toBe(STOREFRONT_GITHUB_ADDRESS);
});

test("the where-i-stand table links a bare ticket id with the ticket address the agent's entry gives", async () => {
  const records = { ...SAMPLE_RECORDS, rows: [{ ...STOREFRONT_RECORD, ticket_url: "" }] };
  const markdown = `## On GitHub\n\n### alpha-basket\n- Links: Forgejo ${STOREFRONT_FORGEJO_ADDRESS} · GitHub ${STOREFRONT_GITHUB_ADDRESS} · Ticket ${STOREFRONT_TICKET_ADDRESS}\n`;

  const [links] = rowTitled(await openSamplePage(markdown, records), BASKET_TITLE);

  expect(linksOf(links)["Ticket ABC-12"]).toBe(STOREFRONT_TICKET_ADDRESS);
});

const OVENS_ADDRESS = "https://github.com/bakery/ovens/pull/12";
const RISE_TIMES_ADDRESS = "https://github.com/bakery/ovens/pull/14";
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600000).toISOString();

const OTHER_PEOPLES_RECORDS = {
  ...SAMPLE_RECORDS,
  waiting_for_review: [
    { repository: "bakery/ovens", number: 12, url: OVENS_ADDRESS, title: "Raise the oven limit", author: "baker-two", waiting_on: "you", checks: { passing: 3, failing: 0, running: 1 }, created_at: daysAgo(3) },
    { repository: "bakery/flour", number: 5, url: "https://github.com/bakery/flour/pull/5", title: "Sift twice", author: "baker-four", waiting_on: "Pastry", checks: { passing: 0, failing: 0, running: 0 }, created_at: daysAgo(2) },
  ],
  teammates: [
    { repository: "bakery/ovens", number: 14, url: RISE_TIMES_ADDRESS, title: "Rise times", author: "baker-three", draft: false, review: "APPROVED", checks: { passing: 5, failing: 1, running: 0 }, updated_at: daysAgo(4) },
    { repository: "bakery/ovens", number: 15, url: "https://github.com/bakery/ovens/pull/15", title: "Crust colour", author: "baker-two", draft: true, review: "", checks: { passing: 2, failing: 0, running: 0 }, updated_at: daysAgo(5) },
  ],
};

function afterHeading(page: OpenedPage, heading: string): Element {
  const headingElement = [...workSection(page).querySelectorAll("h3")].find((candidate) => candidate.textContent === heading);
  if (headingElement?.nextElementSibling == null) throw new Error(`the page has a ${heading} heading`);
  return headingElement.nextElementSibling;
}

function cellWords(table: Element): string[][] {
  return [...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
}

const headersOf = (table: Element) => [...table.querySelectorAll("th")].map((column) => column.textContent);

test("the where-i-stand page lists the pull requests waiting for the review of the Lord or his team under his work", async () => {
  const table = afterHeading(await openSamplePage(SAMPLE_MARKDOWN, OTHER_PEOPLES_RECORDS), "Waiting for your review");

  expect(headersOf(table)).toEqual(["Pull request", "Title", "Author", "Waiting on", "CI", "Age"]);
  expect(cellWords(table)).toEqual([
    ["ovens #12", "Raise the oven limit", "baker-two", "you", "1 running", "3 days ago"],
    ["flour #5", "Sift twice", "baker-four", "Pastry", "no CI", "2 days ago"],
  ]);
  expect(table.querySelector("a")?.getAttribute("href")).toBe(OVENS_ADDRESS);
  expect(table.querySelectorAll("td")[3].getAttribute("data-label")).toBe("Waiting on");
});

test("the where-i-stand page lists his teammates' pull requests with their state, CI and last update", async () => {
  const table = afterHeading(await openSamplePage(SAMPLE_MARKDOWN, OTHER_PEOPLES_RECORDS), "Your teammates' pull requests");

  expect(headersOf(table)).toEqual(["Author", "Pull request", "Title", "State", "CI", "Last updated"]);
  expect(cellWords(table)).toEqual([
    ["baker-three", "ovens #14", "Rise times", "ready, approved", "1 failing", "4 days ago"],
    ["baker-two", "ovens #15", "Crust colour", "draft", "green", "5 days ago"],
  ]);
  expect(table.querySelector("a")?.getAttribute("href")).toBe(RISE_TIMES_ADDRESS);
});

test("the review and teammates' tables say so when they have nothing", async () => {
  const page = await openSamplePage();

  expect(afterHeading(page, "Waiting for your review").textContent).toBe("No pull requests are waiting for your review.");
  expect(afterHeading(page, "Your teammates' pull requests").textContent).toBe("No open pull requests from your teammates.");
});

test("while the records are unknown the where-i-stand page does not say there are no pull requests", async () => {
  const backend = new FakeBackend("## Needs you\n");
  backend.recordsAnswer = new Response("missing", { status: 404 });

  const page = await openPage(backend, PULL_REQUESTS_HASH);

  expect(workSection(page).textContent).toMatch(/Could not fetch the pull request records at /);
  expect(workSection(page).textContent).not.toContain("No pull requests");
  expect(workSection(page).textContent).not.toContain("No open pull requests");
});

test("an agent's Markdown reads as Markdown in the work table and a forge's title stays as written", async () => {
  const markdown = `## In flight\n\n### alpha-oven\n- Links: no pull request · branch alpha-oven · Ticket no ticket\n- Kind: \`mkp\` tool — Teach \`mkp\` to bake\n- Where it stands: runs \`mkp bake\`\n\n## On GitHub\n\n### alpha-basket\n- Links: Forgejo ${STOREFRONT_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket\n- Kind: fix — ignored\n- Where it stands: see \`basket.ts\`\n`;
  const records = recordsWith({ rows: [workRecord({ title: "Rename `total` to *sum*", forgejo: { url: STOREFRONT_FORGEJO_ADDRESS, number: 7, state: "open" } })] });

  const page = await openSamplePage(markdown, records);

  const codeWords = [...workSection(page).querySelectorAll("td code")].map((code) => code.textContent);
  expect(codeWords).toEqual(["basket.ts", "mkp", "mkp", "mkp bake"]);
  expect(workSection(page).textContent).toContain("Rename `total` to *sum*");
});

test("the review and teammates' tables come after the work table and do not join it", async () => {
  const page = await openSamplePage(SAMPLE_MARKDOWN, OTHER_PEOPLES_RECORDS);

  expect([...workSection(page).children].map((child) => child.tagName).slice(-4)).toEqual(["H3", "TABLE", "H3", "TABLE"]);
  expect(titlesOf(page).slice(0, 2)).toEqual(["Basket tour", BASKET_TITLE]);
});

const PAGE_ORDER_MARKDOWN = `## In flight

### alpha-oven
- Links: no pull request · branch alpha-oven · Ticket no ticket
- Kind: bug fix — Keep the oven warm
- Where it stands: building

### alpha-tray
- Links: no pull request · branch alpha-tray · Ticket no ticket
- Kind: new page — Order baking trays
- Where it stands: waiting on the supplier

## On GitHub

### alpha-receipts
- Links: no pull request · \`b2c3d4e\` · Ticket no ticket
- Kind: new page — Print receipts
- Where it stands: merged

### storefront#21
- Links: no pull request · branch storefront#21 · Ticket no ticket
- Kind: new page — Speed up checkout
- Where it stands: review requested
`;

const OVEN_WORK_SECTION_ID = "s-oven-work";

function backendWithTheStoresOrdering(): FakeBackend {
  const backend = new FakeBackend(PAGE_ORDER_MARKDOWN, recordsWith({ rows: [] }));
  const storedPage = backend.storedPage.bind(backend);
  backend.storedPage = () => {
    const page = storedPage();
    const inFlight = page.listing.sections.find((section) => section.name === "In flight")!;
    const lastPosition = Math.max(...page.listing.sections.map((section) => section.position));
    const ovenWork = { ...inFlight, id: OVEN_WORK_SECTION_ID, parentId: inFlight.id, name: "Oven work", position: lastPosition + 2 };
    const sections = [...page.listing.sections.map((section) => (section === inFlight ? { ...section, position: lastPosition + 1 } : section)), ovenWork];
    const rows = page.rows.map((row) => (row.code === "alpha-tray" ? { ...row, sectionId: OVEN_WORK_SECTION_ID } : row));
    return { ...page, listing: { ...page.listing, sections }, rows };
  };
  return backend;
}

test("the where-i-stand table keeps the page's order and names a subsection's rows by their top section", async () => {
  const page = await openPage(backendWithTheStoresOrdering(), PULL_REQUESTS_HASH);

  expect(titlesOf(page)).toEqual(["Keep the oven warm", "Order baking trays", "Print receipts", "Speed up checkout"]);
  expect(linesOf(rowTitled(page, "Order baking trays")[2])).toEqual(["In flight", "waiting on the supplier"]);
});
