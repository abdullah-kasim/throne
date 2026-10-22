import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { PageElement, pageScriptsInOrder } from './where-i-stand-page-scripts.support.ts';

const PAGE_ADDRESS = 'http://127.0.0.1:8080/where-i-stand/';
const RECORDS_FILE_NAME = 'where-i-stand-prs.json';
const MINUTES_SINCE_THE_RECORDS_WERE_READ = 5;

const STOREFRONT_FORGEJO_ADDRESS = 'https://forge.example.com/shop/storefront/pulls/7';
const STOREFRONT_GITHUB_ADDRESS = 'https://github.com/shop/storefront/pull/41';
const STOREFRONT_TICKET_ADDRESS = 'https://tracker.example.com/ABC-12';
const GIFT_CARD_FORGEJO_ADDRESS = 'https://forge.example.com/shop/storefront/pulls/8';
const BASKET_TOUR_ADDRESS = 'https://videos.example.com/basket-tour.mp4';
const THRONE_FORGEJO_ADDRESS = 'https://forge.example.com/court/throne-mirror/pulls/3';
const DOTFILES_GITHUB_ADDRESS = 'https://github.com/court/dotfiles/pull/9';
const THRONE_AND_DOTFILES_SUMMARY = 'Throne and dotfiles';

const SAMPLE_RECORDS = {
  read_at: new Date(Date.now() - MINUTES_SINCE_THE_RECORDS_WERE_READ * 60000).toISOString(),
  days: 14,
  problems: ['forge.example.com: the server answered 502'],
  changes: [`new: [storefront #41](${STOREFRONT_GITHUB_ADDRESS}): waiting on review (ready, CI green)`],
  rows: [
    {
      group: 'Waiting on review',
      repository: 'shop/storefront',
      title: 'Fix the basket total rounding',
      ticket: 'ABC-12',
      ticket_url: STOREFRONT_TICKET_ADDRESS,
      kind: 'bug fix',
      summary: 'Rounds the basket total once',
      forgejo: { url: STOREFRONT_FORGEJO_ADDRESS, number: 7, state: 'open' },
      github: { url: STOREFRONT_GITHUB_ADDRESS, number: 41, state: 'ready, CI green' },
      head_commits: 'GitHub behind Forgejo',
    },
    {
      group: 'Forgejo only',
      repository: 'shop/storefront',
      title: 'Add a gift card page',
      ticket: '',
      ticket_url: '',
      kind: '',
      summary: 'A page to buy gift cards',
      forgejo: { url: GIFT_CARD_FORGEJO_ADDRESS, number: 8, state: 'draft' },
      github: null,
      head_commits: '',
    },
  ],
};

const SAMPLE_MARKDOWN = `## Needs you

### alpha-giftcard
- Links: Forgejo ${GIFT_CARD_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — Add a gift card page
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

interface RenderedPage {
  recordsTime: PageElement;
  workDetails: PageElement;
  pageContent: PageElement;
  refresh: () => Promise<void>;
}

type FileAnswer = (address: string) => Promise<Response>;

function answerWith(markdown: string, recordsText: string | null): FileAnswer {
  return async (address) => {
    if (!address.endsWith(RECORDS_FILE_NAME)) return new Response(markdown);
    return recordsText === null ? new Response('missing', { status: 404 }) : new Response(recordsText);
  };
}

async function openPage(answer: () => FileAnswer): Promise<RenderedPage> {
  const elementsById = new Map<string, PageElement>();
  const elementWithId = (id: string) => elementsById.get(id) ?? elementsById.set(id, new PageElement('div')).get(id)!;
  const browser = vm.createContext({
    document: {
      baseURI: PAGE_ADDRESS,
      hidden: false,
      createElement: (tagName: string) => new PageElement(tagName),
      getElementById: elementWithId,
      addEventListener: () => undefined,
    },
    window: { location: new URL(PAGE_ADDRESS), scrollY: 0, scrollTo: () => undefined },
    URL,
    setInterval: () => 0,
    fetch: (address: string) => answer()(address),
  });
  for (const script of await pageScriptsInOrder()) await vm.runInContext(script, browser);
  return {
    recordsTime: elementWithId('records-time'),
    workDetails: elementWithId('work-details'),
    pageContent: elementWithId('page-content'),
    refresh: () => vm.runInContext('refreshPage()', browser),
  };
}

const renderPage = (markdown: string, recordsText: string | null) => openPage(() => answerWith(markdown, recordsText));

function tableRows(page: RenderedPage): PageElement[][] {
  return page.workDetails
    .find('tbody')
    .flatMap((body) => body.find('tr'))
    .map((row) => row.find('td'));
}

function linesOf(cell: PageElement): string[] {
  return cell.elementChildren().map((line) => line.textContent);
}

function linksOf(cell: PageElement): Record<string, string | null> {
  return Object.fromEntries(cell.find('a').map((link) => [link.textContent, link.getAttribute('href')]));
}

function rowTitled(page: RenderedPage, title: string): PageElement[] {
  const row = tableRows(page).find((cells) => linesOf(cells[1]).includes(title));
  assert.ok(row, `a row is titled ${title}`);
  return row;
}

const renderSamplePage = () => renderPage(SAMPLE_MARKDOWN, JSON.stringify(SAMPLE_RECORDS));

test('the where-i-stand table gives each piece of work its Forgejo, GitHub and ticket links in one column', async () => {
  const [links] = rowTitled(await renderSamplePage(), 'Fix the basket total rounding');
  assert.deepEqual(linksOf(links), {
    'Forgejo #7': STOREFRONT_FORGEJO_ADDRESS,
    'GitHub #41': STOREFRONT_GITHUB_ADDRESS,
    'Ticket ABC-12': STOREFRONT_TICKET_ADDRESS,
  });
  assert.equal(links.getAttribute('data-label'), 'Links');
});

test('the where-i-stand table writes a short word for a missing link instead of leaving it blank', async () => {
  const page = await renderSamplePage();
  assert.deepEqual(linesOf(rowTitled(page, 'Add a gift card page')[0]), ['Forgejo #8', 'not on GitHub yet', 'no ticket']);
  assert.deepEqual(linesOf(rowTitled(page, 'regent')[0]), ['no Forgejo copy', 'not on GitHub yet', 'no ticket']);
});

test('the where-i-stand table says what sort of work each row is and where it stands', async () => {
  const page = await renderSamplePage();
  const [, kind, whereItStands] = rowTitled(page, 'Fix the basket total rounding');
  assert.deepEqual(linesOf(kind), ['bug fix', 'Fix the basket total rounding']);
  assert.deepEqual(linesOf(whereItStands), [
    'Waiting on review; Forgejo open; GitHub ready, CI green; GitHub behind Forgejo',
  ]);
  assert.deepEqual(linesOf(rowTitled(page, 'regent')[1]), ['kind not stated', 'regent']);
});

test("the where-i-stand table gives work without a pull request a row from the agents' entry", async () => {
  const page = await renderSamplePage();
  const [tourLinks, tourKind, tourStands] = rowTitled(page, 'Basket tour');
  assert.deepEqual(linesOf(tourLinks), ['no pull request', BASKET_TOUR_ADDRESS, 'ABC-12']);
  assert.deepEqual(linksOf(tourLinks), { [BASKET_TOUR_ADDRESS]: BASKET_TOUR_ADDRESS });
  assert.deepEqual(linesOf(tourKind), ['explainer video', 'Basket tour']);
  assert.deepEqual(linesOf(tourStands), ['Needs you', 'rendered, waiting for your review']);
  assert.deepEqual(linesOf(rowTitled(page, 'Teach the menu skill to sort')[0]), ['no pull request', 'a1b2c3d', 'no ticket']);
});

test("the where-i-stand table merges an agent's entry into the row for the same pull request", async () => {
  const page = await renderSamplePage();
  const [, kind, whereItStands] = rowTitled(page, 'Add a gift card page');
  assert.deepEqual(linesOf(kind), ['new page', 'Add a gift card page']);
  assert.deepEqual(linesOf(whereItStands), ['Forgejo only; Forgejo draft', 'waiting for your look at the preview']);
  assert.deepEqual(
    tableRows(page).map((cells) => linesOf(cells[1])[1]),
    ['Basket tour', 'Fix the basket total rounding', 'Add a gift card page', 'Teach the menu skill to sort', 'regent'],
  );
});

test('the page draws no row for a superseded entry', async () => {
  const supersededEntries = `## In flight

### alpha-oldgiftcard
- Links: Forgejo ${GIFT_CARD_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: old page — Gift card page, first try
- Where it stands: abandoned
- Superseded by \`### alpha-giftcard\` on 2026-10-20

### alpha-oldtour
- Links: no pull request · ${BASKET_TOUR_ADDRESS} · Ticket ABC-12
- Kind: explainer video — Basket tour, first cut
- Where it stands: replaced
Superseded by \`### stager-tour\` on 2026-10-20

`;
  const page = await renderPage(supersededEntries + SAMPLE_MARKDOWN, JSON.stringify(SAMPLE_RECORDS));
  const titles = tableRows(page).map((cells) => linesOf(cells[1])[1]);
  assert.deepEqual(titles, ['Basket tour', 'Fix the basket total rounding', 'Add a gift card page', 'Teach the menu skill to sort', 'regent']);
  assert.deepEqual(linesOf(rowTitled(page, 'Add a gift card page')[1]), ['new page', 'Add a gift card page']);
  assert.match(page.pageContent.textContent, /alpha-oldgiftcard/);
  assert.match(page.pageContent.textContent, /alpha-oldtour/);
});

test('the where-i-stand page says when the records were read and names a host that could not be read', async () => {
  const page = await renderSamplePage();
  assert.match(page.recordsTime.textContent, new RegExp(`^Pull requests read .+, ${MINUTES_SINCE_THE_RECORDS_WERE_READ} minutes ago\\.$`));
  assert.deepEqual(
    page.workDetails.find('li').map((item) => item.textContent),
    ['Could not read: forge.example.com: the server answered 502', 'new: storefront #41: waiting on review (ready, CI green)'],
  );
});

test('the where-i-stand page shows the changes since the last refresh', async () => {
  const page = await renderSamplePage();
  assert.equal(page.workDetails.find('h3')[0].textContent, 'Changed since the last refresh');
  const [changeLink] = page.workDetails.find('ul')[1].find('a');
  assert.equal(changeLink.getAttribute('href'), STOREFRONT_GITHUB_ADDRESS);
});

test("the where-i-stand page still shows the entries' rows and the agents' sections when the pull request records cannot be fetched", async () => {
  for (const unreadableRecords of [null, '{ not json']) {
    const page = await renderPage(SAMPLE_MARKDOWN, unreadableRecords);
    assert.match(page.recordsTime.textContent, /^Could not fetch the pull request records at /);
    assert.deepEqual(
      tableRows(page).map((cells) => linesOf(cells[1])[1]),
      ['Add a gift card page', 'Basket tour', 'Teach the menu skill to sort', 'regent'],
    );
    assert.deepEqual(page.pageContent.find('h2').map((heading) => heading.textContent), ['Needs you', 'Done']);
  }
});

test('the where-i-stand page keeps the pull request records it last fetched when the records file can no longer be fetched', async () => {
  let recordsText: string | null = JSON.stringify(SAMPLE_RECORDS);
  const page = await openPage(() => answerWith(SAMPLE_MARKDOWN, recordsText));
  recordsText = null;
  await page.refresh();
  assert.match(
    page.recordsTime.textContent,
    new RegExp(`^Could not fetch the pull request records at .+\\. Showing what was last fetched\\. Pull requests read .+, ${MINUTES_SINCE_THE_RECORDS_WERE_READ} minutes ago\\.$`),
  );
  assert.ok(rowTitled(page, 'Fix the basket total rounding'));
});

test('a late answer to an earlier refresh does not replace what a later refresh of the where-i-stand page showed', async () => {
  const heldAnswers: (() => void)[] = [];
  let answer = answerWith(SAMPLE_MARKDOWN, JSON.stringify(SAMPLE_RECORDS));
  const page = await openPage(() => answer);
  const fullAnswer = answer;
  answer = (address) => new Promise((release) => heldAnswers.push(() => release(fullAnswer(address))));
  const earlierRefresh = page.refresh();
  answer = answerWith(SAMPLE_MARKDOWN, JSON.stringify({ ...SAMPLE_RECORDS, rows: SAMPLE_RECORDS.rows.slice(1) }));
  await page.refresh();
  heldAnswers.forEach((release) => release());
  await earlierRefresh;
  assert.equal(tableRows(page).some((cells) => linesOf(cells[1]).includes('Fix the basket total rounding')), false);
});

test("the where-i-stand table links a bare ticket id with the ticket address the agent's entry gives", async () => {
  const [storefrontRecord] = SAMPLE_RECORDS.rows;
  const records = { ...SAMPLE_RECORDS, rows: [{ ...storefrontRecord, ticket_url: '' }] };
  const markdown = `## On GitHub\n\n### alpha-basket\n- Links: Forgejo ${STOREFRONT_FORGEJO_ADDRESS} · GitHub ${STOREFRONT_GITHUB_ADDRESS} · Ticket ${STOREFRONT_TICKET_ADDRESS}\n`;
  const [links] = rowTitled(await renderPage(markdown, JSON.stringify(records)), 'Fix the basket total rounding');
  assert.equal(linksOf(links)['Ticket ABC-12'], STOREFRONT_TICKET_ADDRESS);
});

const THRONE_AND_DOTFILES_RECORDS = {
  ...SAMPLE_RECORDS,
  rows: [
    ...SAMPLE_RECORDS.rows,
    { group: 'Forgejo only', repository: 'court/throne-mirror', title: 'Teach the court to bow', forgejo: { url: THRONE_FORGEJO_ADDRESS, number: 3, state: 'open' }, github: null },
    { group: 'Waiting on review', repository: 'court/dotfiles', title: 'Shorter shell prompt', forgejo: null, github: { url: DOTFILES_GITHUB_ADDRESS, number: 9, state: 'ready' } },
    { group: 'Forgejo only', repository: 'court/scratch-throne-forge-test', title: 'Try the forge', forgejo: { url: 'https://forge.example.com/court/scratch-throne-forge-test/pulls/1', number: 1, state: 'open' }, github: null },
  ],
};

const THRONE_AND_DOTFILES_MARKDOWN = `## Needs you

### alpha-bow
- Links: Forgejo ${THRONE_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new feature — Teach the court to bow
- Where it stands: waiting for your word

### alpha-giftcard
- Links: Forgejo ${GIFT_CARD_FORGEJO_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — Add a gift card page

## In flight

### alpha-connectors
- Links: no pull request · throne main 7e60aced · Ticket no ticket
- Kind: fix — Keep the connectors

### alpha-prompt
- Links: no pull request · not started · Ticket no ticket
- Kind: dotfiles — Colour the shell prompt

### alpha-oven
- Links: no pull request · local main a5bdedd7 · Ticket no ticket
- Kind: change — Warm the oven earlier

## Done
`;

function mainTableTitles(page: RenderedPage): string[] {
  const tables = page.workDetails.elementChildren().filter((child) => child.tagName === 'TABLE');
  return tables.flatMap((table) => table.find('tr').slice(1)).map((row) => linesOf(row.find('td')[1])[1]);
}

function spoilersIn(container: PageElement): PageElement[] {
  return container.find('details');
}

function spoilerTitles(page: RenderedPage): string[] {
  const [spoiler] = spoilersIn(page.workDetails);
  return spoiler.find('tbody').flatMap((body) => body.find('tr')).map((row) => linesOf(row.find('td')[1])[1]);
}

const summaryOf = (spoiler: PageElement) => spoiler.find('summary')[0].textContent;
const renderThroneAndDotfilesPage = () => renderPage(THRONE_AND_DOTFILES_MARKDOWN, JSON.stringify(THRONE_AND_DOTFILES_RECORDS));

test('throne and dotfiles pull requests move out of the main work table into a collapsed section', async () => {
  const page = await renderPage('## Done\n', JSON.stringify(THRONE_AND_DOTFILES_RECORDS));
  assert.deepEqual(spoilerTitles(page), ['Teach the court to bow', 'Shorter shell prompt']);
  assert.equal(summaryOf(spoilersIn(page.workDetails)[0]), `${THRONE_AND_DOTFILES_SUMMARY} (2)`);
  assert.deepEqual(mainTableTitles(page), ['Fix the basket total rounding', 'Add a gift card page', 'Try the forge']);
});

test('a dotfiles entry with no pull request is sorted by its Kind line', async () => {
  const page = await renderThroneAndDotfilesPage();
  assert.ok(spoilerTitles(page).includes('Colour the shell prompt'));
  assert.ok(!mainTableTitles(page).includes('Colour the shell prompt'));
});

test('a no-pull-request entry whose commit names the throne repository is sorted with throne work', async () => {
  const page = await renderThroneAndDotfilesPage();
  assert.ok(spoilerTitles(page).includes('Keep the connectors'));
  assert.ok(!mainTableTitles(page).includes('Keep the connectors'));
});

test('work for other repositories stays in the main work table', async () => {
  const page = await renderThroneAndDotfilesPage();
  assert.deepEqual(mainTableTitles(page), ['Fix the basket total rounding', 'Add a gift card page', 'Try the forge', 'Warm the oven earlier']);
});

test("a throne entry that needs the Lord is counted in the collapsed section's summary", async () => {
  const page = await renderThroneAndDotfilesPage();
  assert.deepEqual(spoilerTitles(page), ['Teach the court to bow', 'Shorter shell prompt', 'Keep the connectors', 'Colour the shell prompt']);
  assert.equal(summaryOf(spoilersIn(page.workDetails)[0]), `${THRONE_AND_DOTFILES_SUMMARY} (4, 1 needs you)`);
  assert.equal(summaryOf(spoilersIn(page.pageContent)[0]), `${THRONE_AND_DOTFILES_SUMMARY} (3, 1 needs you)`);
});

test('throne and dotfiles entries move out of their sections into one collapsed section that names where each came from', async () => {
  const sections = (await renderThroneAndDotfilesPage()).pageContent.elementChildren();
  const headingsIn = (container: PageElement, level: string) => container.find(level).map((heading) => heading.textContent);
  assert.deepEqual(sections.map((section) => headingsIn(section, 'h2')), [['Needs you'], ['In flight'], ['Done'], []]);
  assert.deepEqual(sections.slice(0, 3).map((section) => headingsIn(section, 'h3')), [['alpha-giftcard'], ['alpha-oven'], []]);
  const [spoiler] = spoilersIn(sections[3]);
  assert.deepEqual(headingsIn(spoiler, 'h3'), ['alpha-bow', 'alpha-connectors', 'alpha-prompt']);
  assert.deepEqual(headingsIn(spoiler, 'p'), ['Section: Needs you', 'Section: In flight', 'Section: In flight']);
  assert.ok(sections[0].classes.has('needs-you'));
});

test('the throne and dotfiles sections are collapsed when the page opens', async () => {
  const page = await renderThroneAndDotfilesPage();
  const spoilers = [...spoilersIn(page.workDetails), ...spoilersIn(page.pageContent)];
  assert.equal(spoilers.length, 2);
  assert.deepEqual(spoilers.map((spoiler) => [spoiler.open ?? false, spoiler.getAttribute('open')]), [[false, null], [false, null]]);
});

test('a throne and dotfiles section the Lord opened stays open when the page refreshes', async () => {
  let markdown = THRONE_AND_DOTFILES_MARKDOWN;
  const page = await openPage(() => answerWith(markdown, JSON.stringify(THRONE_AND_DOTFILES_RECORDS)));
  const openedSpoilers = [...spoilersIn(page.workDetails), ...spoilersIn(page.pageContent)];
  openedSpoilers.forEach((spoiler) => (spoiler.open = true));
  markdown = `${THRONE_AND_DOTFILES_MARKDOWN}\n- Baked the first loaf.\n`;
  await page.refresh();
  const refreshedSpoilers = [...spoilersIn(page.workDetails), ...spoilersIn(page.pageContent)];
  assert.ok(refreshedSpoilers.every((spoiler, index) => spoiler !== openedSpoilers[index]), 'the refresh rendered the sections again');
  assert.deepEqual(refreshedSpoilers.map((spoiler) => spoiler.open), [true, true]);
});

test('a no-pull-request entry whose address ends in .git is sorted with throne and dotfiles work', async () => {
  const markdown = `## In flight\n\n### alpha-clone\n- Links: no pull request · https://github.com/court/dotfiles.git main cece0c80 · Ticket no ticket\n- Kind: change — Clone the dotfiles\n`;
  const page = await renderPage(markdown, JSON.stringify({ ...SAMPLE_RECORDS, rows: [] }));
  assert.deepEqual(spoilerTitles(page), ['Clone the dotfiles']);
});

test('a throne and dotfiles section that empties and fills again comes back collapsed', async () => {
  let markdown = THRONE_AND_DOTFILES_MARKDOWN;
  let recordsText = JSON.stringify(THRONE_AND_DOTFILES_RECORDS);
  const page = await openPage(() => answerWith(markdown, recordsText));
  [...spoilersIn(page.workDetails), ...spoilersIn(page.pageContent)].forEach((spoiler) => (spoiler.open = true));
  [markdown, recordsText] = ['## Done\n', JSON.stringify(SAMPLE_RECORDS)];
  await page.refresh();
  assert.equal(spoilersIn(page.workDetails).length + spoilersIn(page.pageContent).length, 0);
  [markdown, recordsText] = [THRONE_AND_DOTFILES_MARKDOWN, JSON.stringify(THRONE_AND_DOTFILES_RECORDS)];
  await page.refresh();
  assert.deepEqual([...spoilersIn(page.workDetails), ...spoilersIn(page.pageContent)].map((spoiler) => spoiler.open ?? false), [false, false]);
});

const OVENS_ADDRESS = 'https://github.com/bakery/ovens/pull/12';
const RISE_TIMES_ADDRESS = 'https://github.com/bakery/ovens/pull/14';
const DAYS_AGO = (days: number) => new Date(Date.now() - days * 24 * 3600000).toISOString();

const OTHER_PEOPLES_RECORDS = {
  ...SAMPLE_RECORDS,
  waiting_for_review: [
    { host: 'github.com', repository: 'bakery/ovens', number: 12, url: OVENS_ADDRESS, title: 'Raise the oven limit', author: 'baker-two', waiting_on: 'you', checks: { passing: 3, failing: 0, running: 1 }, created_at: DAYS_AGO(3) },
    { host: 'github.com', repository: 'bakery/flour', number: 5, url: 'https://github.com/bakery/flour/pull/5', title: 'Sift twice', author: 'baker-four', waiting_on: 'Pastry', checks: { passing: 0, failing: 0, running: 0 }, created_at: DAYS_AGO(2) },
  ],
  teammates: [
    { host: 'github.com', repository: 'bakery/ovens', number: 14, url: RISE_TIMES_ADDRESS, title: 'Rise times', author: 'baker-three', draft: false, review: 'APPROVED', checks: { passing: 5, failing: 1, running: 0 }, updated_at: DAYS_AGO(4) },
    { host: 'github.com', repository: 'bakery/ovens', number: 15, url: 'https://github.com/bakery/ovens/pull/15', title: 'Crust colour', author: 'baker-two', draft: true, review: '', checks: { passing: 2, failing: 0, running: 0 }, updated_at: DAYS_AGO(5) },
  ],
};

function tableAfterHeading(page: RenderedPage, heading: string): PageElement {
  const children = page.workDetails.elementChildren();
  const headingIndex = children.findIndex((child) => child.tagName === 'H3' && child.textContent === heading);
  assert.notEqual(headingIndex, -1, `the page has a ${heading} heading`);
  return children[headingIndex + 1];
}

function cellWords(table: PageElement): string[][] {
  return table.find('tbody')[0].find('tr').map((row) => row.find('td').map((cell) => cell.textContent));
}

const renderOtherPeoplesPage = () => renderPage(SAMPLE_MARKDOWN, JSON.stringify(OTHER_PEOPLES_RECORDS));

test('the where-i-stand page lists the pull requests waiting for the review of the Lord or his team under his work', async () => {
  const table = tableAfterHeading(await renderOtherPeoplesPage(), 'Waiting for your review');
  assert.deepEqual(table.find('th').map((column) => column.textContent), ['Pull request', 'Title', 'Author', 'Waiting on', 'CI', 'Age']);
  assert.deepEqual(cellWords(table), [
    ['ovens #12', 'Raise the oven limit', 'baker-two', 'you', '1 running', '3 days ago'],
    ['flour #5', 'Sift twice', 'baker-four', 'Pastry', 'no CI', '2 days ago'],
  ]);
  assert.equal(table.find('a')[0].getAttribute('href'), OVENS_ADDRESS);
  assert.equal(table.find('td')[3].getAttribute('data-label'), 'Waiting on');
});

test("the where-i-stand page lists his teammates' pull requests with their state, CI and last update", async () => {
  const table = tableAfterHeading(await renderOtherPeoplesPage(), "Your teammates' pull requests");
  assert.deepEqual(table.find('th').map((column) => column.textContent), ['Author', 'Pull request', 'Title', 'State', 'CI', 'Last updated']);
  assert.deepEqual(cellWords(table), [
    ['baker-three', 'ovens #14', 'Rise times', 'ready, approved', '1 failing', '4 days ago'],
    ['baker-two', 'ovens #15', 'Crust colour', 'draft', 'green', '5 days ago'],
  ]);
  assert.equal(table.find('a')[0].getAttribute('href'), RISE_TIMES_ADDRESS);
});

test("the review and teammates' tables say so when they have nothing, including for records written before they existed", async () => {
  for (const records of [{ ...OTHER_PEOPLES_RECORDS, waiting_for_review: [], teammates: [] }, SAMPLE_RECORDS]) {
    const page = await renderPage(SAMPLE_MARKDOWN, JSON.stringify(records));
    assert.equal(tableAfterHeading(page, 'Waiting for your review').textContent, 'No pull requests are waiting for your review.');
    assert.equal(tableAfterHeading(page, "Your teammates' pull requests").textContent, 'No open pull requests from your teammates.');
  }
});

test("the review and teammates' tables come after the work table and do not join it", async () => {
  const page = await renderOtherPeoplesPage();
  const tags = page.workDetails.elementChildren().map((child) => child.tagName);
  assert.deepEqual(tags.slice(-4), ['H3', 'TABLE', 'H3', 'TABLE']);
  assert.deepEqual(mainTableTitles(page).slice(0, 2), ['Basket tour', 'Fix the basket total rounding']);
});
