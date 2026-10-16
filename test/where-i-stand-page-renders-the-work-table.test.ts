import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const PAGE_FILE = resolve(import.meta.dirname, '..', '.claude/skills/where-i-stand/page/index.html');
const PAGE_ADDRESS = 'http://127.0.0.1:8080/where-i-stand/';
const RECORDS_FILE_NAME = 'where-i-stand-prs.json';
const MINUTES_SINCE_THE_RECORDS_WERE_READ = 5;

const STOREFRONT_FORGEJO_ADDRESS = 'https://forge.example.com/shop/storefront/pulls/7';
const STOREFRONT_GITHUB_ADDRESS = 'https://github.com/shop/storefront/pull/41';
const STOREFRONT_TICKET_ADDRESS = 'https://tracker.example.com/ABC-12';
const GIFT_CARD_FORGEJO_ADDRESS = 'https://forge.example.com/shop/storefront/pulls/8';
const BASKET_TOUR_ADDRESS = 'https://videos.example.com/basket-tour.mp4';

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

class PageElement {
  readonly tagName: string;
  childNodes: (PageElement | string)[] = [];
  readonly classes = new Set<string>();
  readonly classList = { add: (name: string) => this.classes.add(name) };
  private readonly attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  append(...nodes: (PageElement | string)[]): void {
    this.childNodes.push(...nodes);
  }

  replaceChildren(...nodes: (PageElement | string)[]): void {
    this.childNodes = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((node) => (typeof node === 'string' ? node : node.textContent)).join('');
  }

  set textContent(text: string) {
    this.childNodes = [text];
  }

  elementChildren(): PageElement[] {
    return this.childNodes.filter((node): node is PageElement => typeof node !== 'string');
  }

  descendantsNamed(tagName: string): PageElement[] {
    return this.elementChildren().flatMap((child) => [
      ...(child.tagName === tagName.toUpperCase() ? [child] : []),
      ...child.descendantsNamed(tagName),
    ]);
  }
}

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
    window: { scrollY: 0, scrollTo: () => undefined },
    URL,
    setInterval: () => 0,
    fetch: (address: string) => answer()(address),
  });
  const page = await readFile(PAGE_FILE, 'utf8');
  await vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '', browser);
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
    .descendantsNamed('tbody')
    .flatMap((body) => body.descendantsNamed('tr'))
    .map((row) => row.descendantsNamed('td'));
}

function linesOf(cell: PageElement): string[] {
  return cell.elementChildren().map((line) => line.textContent);
}

function linksOf(cell: PageElement): Record<string, string | null> {
  return Object.fromEntries(cell.descendantsNamed('a').map((link) => [link.textContent, link.getAttribute('href')]));
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

test('the where-i-stand page says when the records were read and names a host that could not be read', async () => {
  const page = await renderSamplePage();
  assert.match(page.recordsTime.textContent, new RegExp(`^Pull requests read .+, ${MINUTES_SINCE_THE_RECORDS_WERE_READ} minutes ago\\.$`));
  assert.deepEqual(
    page.workDetails.descendantsNamed('li').map((item) => item.textContent),
    ['Could not read: forge.example.com: the server answered 502', 'new: storefront #41: waiting on review (ready, CI green)'],
  );
});

test('the where-i-stand page shows the changes since the last refresh', async () => {
  const page = await renderSamplePage();
  assert.deepEqual(page.workDetails.descendantsNamed('h3').map((heading) => heading.textContent), ['Changed since the last refresh']);
  const [changeLink] = page.workDetails.descendantsNamed('ul')[1].descendantsNamed('a');
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
    assert.deepEqual(page.pageContent.descendantsNamed('h2').map((heading) => heading.textContent), ['Needs you', 'Done']);
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
