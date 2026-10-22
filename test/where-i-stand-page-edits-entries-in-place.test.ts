import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { SaveOutcome } from '../src/where-i-stand/page-save.ts';
import { renderSaveAnswer } from '../src/where-i-stand/where-i-stand-messages.ts';
import { PageElement, pageScriptsInOrder } from './where-i-stand-page-scripts.support.ts';

const PAGE_ADDRESS = 'http://127.0.0.1:8080/where-i-stand/';
const SAVE_ADDRESS = 'http://127.0.0.1:8080/where-i-stand/save';
const PREVIEW_ADDRESS = 'https://forge.example.com/shop/storefront/pulls/8';
const RECIPE_ADDRESS = 'https://recipes.example.com/rye';

const GIFT_CARD_ENTRY = `### alpha-giftcard

- Links: Forgejo ${PREVIEW_ADDRESS} · GitHub not on GitHub yet · Ticket no ticket
- Kind: new page — Add a gift card page
- Where it stands: see [the preview](${PREVIEW_ADDRESS}) and ${RECIPE_ADDRESS}, run \`npm test\`, **waiting** on you
- Verified: the recipe at <${RECIPE_ADDRESS}> bakes 2 \\* 6 loaves`;

const MENU_ENTRY = `### alpha-menu
- Links: no pull request · \`a1b2c3d\` · Ticket no ticket
- Where it stands: on local main`;

const FIRST_JUST_HAPPENED_LINE = '- delivered menu: the menu skill sorts';
const SECOND_JUST_HAPPENED_LINE = `- filed giftcard: a page to buy gift cards, see ${RECIPE_ADDRESS}`;

const SAMPLE_MARKDOWN = `## Just happened

${FIRST_JUST_HAPPENED_LINE}
${SECOND_JUST_HAPPENED_LINE}

## Needs you

${GIFT_CARD_ENTRY}

## Done

${MENU_ENTRY}
`;

const SAMPLE_RECORDS = {
  read_at: new Date().toISOString(),
  rows: [],
  waiting_for_review: [{ repository: 'shop/storefront', number: 9, url: 'https://github.com/shop/storefront/pull/9', title: 'Bake rye', author: 'baker' }],
  teammates: [],
};

interface SaveRequest {
  address: string;
  method: string;
  body: { loaded: string; edited: string };
}

interface SaveAnswer {
  status: number;
  body: string;
}

class OpenedPage {
  markdown = SAMPLE_MARKDOWN;
  saveAnswer: SaveAnswer = { status: 200, body: '{"outcome":"saved","message":"Saved."}' };
  readonly saveRequests: SaveRequest[] = [];
  readonly browser = { activeElement: null as PageElement | null };
  private readonly elementsById = new Map<string, PageElement>();
  private readonly listeners = new Map<string, (event: object) => void>();
  readonly context: vm.Context;

  constructor() {
    const browser = this.browser;
    this.context = vm.createContext({
      document: {
        baseURI: PAGE_ADDRESS,
        hidden: false,
        get activeElement() {
          return browser.activeElement;
        },
        createElement: (tagName: string) => new PageElement(tagName, browser),
        getElementById: (id: string) => this.elementWithId(id),
        addEventListener: (type: string, listener: (event: object) => void) => this.listeners.set(type, listener),
      },
      window: {
        location: new URL(PAGE_ADDRESS),
        scrollY: 0,
        scrollTo: () => undefined,
        getSelection: () => ({ anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, setBaseAndExtent: () => undefined }),
      },
      URL,
      setInterval: () => 0,
      fetch: (address: string, options?: { method?: string; body?: string }) => this.answer(address, options),
    });
  }

  elementWithId(id: string): PageElement {
    return this.elementsById.get(id) ?? this.elementsById.set(id, new PageElement('div', this.browser)).get(id)!;
  }

  private async answer(address: string, options?: { method?: string; body?: string }): Promise<Response> {
    if (options?.method === 'POST') {
      this.saveRequests.push({ address, method: options.method, body: JSON.parse(options.body ?? '{}') });
      return new Response(this.saveAnswer.body, { status: this.saveAnswer.status });
    }
    return new Response(address.endsWith('.json') ? JSON.stringify(SAMPLE_RECORDS) : this.markdown);
  }

  get content(): PageElement {
    return this.elementWithId('page-content');
  }

  editors(): PageElement[] {
    return this.content.find('.unit-editor');
  }

  editorAfterHeading(identity: string): PageElement {
    const headings = this.content.find('h3');
    const heading = headings.find((candidate) => candidate.textContent === identity);
    assert.ok(heading, `the page shows the ${identity} heading`);
    const siblings = heading.parentNode!.childNodes;
    const unit = siblings[siblings.indexOf(heading) + 1] as PageElement;
    const [editor] = unit.find('.unit-editor');
    assert.ok(editor, `an editor follows the ${identity} heading`);
    return editor;
  }

  editorShowing(text: string): PageElement {
    const editor = this.editors().find((candidate) => candidate.textContent.includes(text));
    assert.ok(editor, `an editor shows ${text}`);
    return editor;
  }

  lineOf(editor: PageElement, startsWith: string): PageElement {
    const line = editor.childNodes.find((node) => node.textContent.startsWith(startsWith));
    assert.ok(line instanceof PageElement, `a line starts with ${startsWith}`);
    return line;
  }

  unitMarkdownOf(editor: PageElement): string {
    this.context.editorToConvert = editor;
    return vm.runInContext('unitMarkdown(shownUnitOfEditor(editorToConvert))', this.context);
  }

  type(editor: PageElement): void {
    this.listeners.get('input')!({ target: editor });
  }

  async press(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean }): Promise<{ defaultPrevented: boolean }> {
    const event = { key, ...modifiers, defaultPrevented: false, preventDefault: () => (event.defaultPrevented = true) };
    this.listeners.get('keydown')!(event);
    await this.settle();
    return event;
  }

  async click(button: PageElement): Promise<void> {
    this.listeners.get('click')!({ target: button, preventDefault: () => undefined });
    await this.settle();
  }

  buttonOf(editor: PageElement, action: string): PageElement {
    const [button] = editor.parentNode!.find(`[data-action]`).filter((candidate) => candidate.getAttribute('data-action') === action);
    assert.ok(button, `the entry has a ${action} button`);
    return button;
  }

  statusOf(editor: PageElement): string {
    return editor.parentNode!.find('.unit-status')[0]?.textContent ?? '';
  }

  refresh(): Promise<void> {
    return vm.runInContext('refreshPage()', this.context);
  }

  private async settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
}

const pageScripts = await pageScriptsInOrder();

async function openPage(): Promise<OpenedPage> {
  const page = new OpenedPage();
  vm.runInContext('globalThis.shownUnitOfEditor = (editor) => unitOfBlock.get(editor.closest(".unit"))', page.context);
  for (const script of pageScripts) await vm.runInContext(script, page.context);
  return page;
}

function retype(line: PageElement, ...children: (PageElement | string)[]): void {
  line.replaceChildren(...children);
}

test('every entry and every Just happened line on the page can be edited where it is shown', async () => {
  const page = await openPage();
  assert.equal(page.editorAfterHeading('alpha-giftcard').getAttribute('contenteditable'), 'true');
  assert.equal(page.editorAfterHeading('alpha-menu').getAttribute('contenteditable'), 'true');
  assert.equal(page.editorShowing('delivered menu').getAttribute('contenteditable'), 'true');
  assert.equal(page.editorShowing('filed giftcard').getAttribute('contenteditable'), 'true');
  assert.equal(page.editors().length, 4);
  const giftCardLinks = page.editorAfterHeading('alpha-giftcard').find('a').map((link) => link.getAttribute('href'));
  assert.deepEqual(giftCardLinks, [PREVIEW_ADDRESS, PREVIEW_ADDRESS, RECIPE_ADDRESS, RECIPE_ADDRESS]);
  assert.deepEqual(page.editorAfterHeading('alpha-giftcard').find('code').map((code) => code.textContent), ['npm test']);
});

test('the pull request tables and the section headings cannot be edited', async () => {
  const page = await openPage();
  const workDetails = page.elementWithId('work-details');
  assert.ok(page.editors().length > 0, 'the entries beside the headings are editable');
  assert.ok(workDetails.find('table').length > 0, 'the review table is shown');
  assert.deepEqual(workDetails.find('[contenteditable]'), []);
  for (const heading of [...page.content.find('h2'), ...page.content.find('h3')]) {
    assert.equal(heading.closest('[contenteditable]'), null, `${heading.textContent} is not editable`);
  }
  assert.deepEqual(page.content.find('h2').map((heading) => heading.textContent), ['Just happened', 'Needs you', 'Done']);
});

test('an entry the Lord did not touch comes back as exactly the Markdown it was loaded from', async () => {
  const page = await openPage();
  assert.equal(page.unitMarkdownOf(page.editorAfterHeading('alpha-giftcard')), GIFT_CARD_ENTRY);
  assert.equal(page.unitMarkdownOf(page.editorAfterHeading('alpha-menu')), MENU_ENTRY);
  assert.equal(page.unitMarkdownOf(page.editorShowing('filed giftcard')), SECOND_JUST_HAPPENED_LINE);
  const editor = page.editorAfterHeading('alpha-giftcard');
  editor.focus();
  await page.press('s', { metaKey: true });
  assert.deepEqual(page.saveRequests, []);
});

test('an edited entry keeps its list lines, links, bare addresses, inline code and bold', async () => {
  const page = await openPage();
  const editor = page.editorAfterHeading('alpha-giftcard');
  const line = page.lineOf(editor, 'Where it stands');
  retype(line, ...line.childNodes, ' today');
  assert.equal(page.unitMarkdownOf(editor), GIFT_CARD_ENTRY.replace('on you\n', 'on you today\n'));
});

test("saving an entry posts its loaded text and its new text to the page's own folder", async () => {
  const page = await openPage();
  const editor = page.editorAfterHeading('alpha-menu');
  retype(page.lineOf(editor, 'Where it stands'), 'Where it stands: merged to main');
  page.type(editor);
  await page.click(page.buttonOf(editor, 'save'));
  assert.deepEqual(page.saveRequests, [
    {
      address: SAVE_ADDRESS,
      method: 'POST',
      body: { loaded: MENU_ENTRY, edited: MENU_ENTRY.replace('on local main', 'merged to main') },
    },
  ]);
});

test('the Lord can remove a whole entry from the page', async () => {
  const page = await openPage();
  page.saveAnswer = { status: 200, body: '{"outcome":"saved","message":"Removed alpha-menu."}' };
  page.markdown = SAMPLE_MARKDOWN.replace(`${MENU_ENTRY}\n`, '');
  const removeButton = page.buttonOf(page.editorAfterHeading('alpha-menu'), 'remove');
  removeButton.focus();
  await page.click(removeButton);
  assert.deepEqual(page.saveRequests.map(({ body }) => body), [{ loaded: MENU_ENTRY, edited: '' }]);
  assert.equal(page.content.find('h3').some((heading) => heading.textContent === 'alpha-menu'), false);
  assert.equal(page.browser.activeElement, page.editorAfterHeading('alpha-giftcard'), 'focus moves to the entry beside the removed one');
  assert.equal(page.elementWithId('save-announcement').textContent, 'Removed alpha-menu.');
});

test("a refused save says the entry changed and shows the current entry without losing the Lord's text", async () => {
  const page = await openPage();
  const editor = page.editorAfterHeading('alpha-menu');
  retype(page.lineOf(editor, 'Where it stands'), 'Where it stands: the Lord says ship it');
  page.type(editor);
  page.markdown = SAMPLE_MARKDOWN.replace('on local main', 'merged by an agent');
  const refusal = renderSaveAnswer({ outcome: SaveOutcome.EntryChanged });
  page.saveAnswer = { status: 409, body: JSON.stringify({ outcome: SaveOutcome.EntryChanged, message: refusal }) };
  editor.focus();
  await page.press('s', { ctrlKey: true });
  const current = page.editorAfterHeading('alpha-menu');
  assert.notEqual(current, editor);
  assert.match(current.textContent, /merged by an agent/);
  assert.equal(page.statusOf(current), refusal);
  const unsaved = current.parentNode!.find('.unsaved');
  assert.equal(unsaved.length, 1);
  assert.match(unsaved[0].textContent, /the Lord says ship it/);
});

test('a failed save says so', async () => {
  const page = await openPage();
  const editor = page.editorAfterHeading('alpha-menu');
  retype(page.lineOf(editor, 'Where it stands'), 'Where it stands: shipped');
  page.type(editor);
  const failure = renderSaveAnswer({ outcome: SaveOutcome.Failed, reason: 'the page could not be written' });
  page.saveAnswer = { status: 500, body: JSON.stringify({ outcome: SaveOutcome.Failed, message: failure }) };
  await page.click(page.buttonOf(editor, 'save'));
  assert.equal(page.statusOf(editor), failure);
  assert.equal(page.editorAfterHeading('alpha-menu'), editor);
  assert.match(editor.textContent, /shipped/);
  page.saveAnswer = { status: 502, body: 'Bad Gateway' };
  await page.click(page.buttonOf(editor, 'save'));
  assert.equal(page.statusOf(editor), 'Not saved: the page server answered 502.');
});

test('Cmd or Ctrl S saves the focused entry', async () => {
  const page = await openPage();
  const nothingFocused = await page.press('s', { metaKey: true });
  assert.equal(nothingFocused.defaultPrevented, true);
  assert.deepEqual(page.saveRequests, []);
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
    const editor = page.editorShowing('delivered menu');
    retype(page.lineOf(editor, 'delivered menu'), 'delivered menu: the menu skill sorts by price');
    editor.focus();
    const pressed = await page.press('s', modifiers);
    assert.equal(pressed.defaultPrevented, true);
    assert.deepEqual(page.saveRequests.at(-1)?.body, { loaded: FIRST_JUST_HAPPENED_LINE, edited: `${FIRST_JUST_HAPPENED_LINE} by price` });
  }
  assert.equal(page.saveRequests.length, 2);
});

test('a save is announced once, after focus is back in the entry, so a screen reader does not cut it off', async () => {
  const page = await openPage();
  const announcement = page.elementWithId('save-announcement');
  const announced: { text: string; focused: PageElement | null }[] = [];
  Object.defineProperty(announcement, 'textContent', { set: (text: string) => announced.push({ text, focused: page.browser.activeElement }) });
  const editor = page.editorAfterHeading('alpha-menu');
  retype(page.lineOf(editor, 'Where it stands'), 'Where it stands: announced once');
  page.type(editor);
  editor.focus();
  const saved = renderSaveAnswer({ outcome: SaveOutcome.Saved, sameWorkGroups: [] });
  page.saveAnswer = { status: 200, body: JSON.stringify({ outcome: SaveOutcome.Saved, message: saved }) };
  await page.press('s', { metaKey: true });
  assert.deepEqual(announced.map(({ text }) => text), ['Saving.', saved]);
  assert.equal(announced.at(-1)?.focused, page.editorAfterHeading('alpha-menu'));
});

test('pressing save again while a save is on its way sends it only once', async () => {
  const page = await openPage();
  const editor = page.editorAfterHeading('alpha-menu');
  retype(page.lineOf(editor, 'Where it stands'), 'Where it stands: shipped twice');
  page.type(editor);
  editor.focus();
  page.saveAnswer = { status: 200, body: JSON.stringify({ outcome: SaveOutcome.Saved, message: renderSaveAnswer({ outcome: SaveOutcome.Saved, sameWorkGroups: [] }) }) };
  await Promise.all([page.press('s', { metaKey: true }), page.click(page.buttonOf(editor, 'save'))]);
  assert.equal(page.saveRequests.length, 1);
  assert.equal(page.elementWithId('save-announcement').textContent, renderSaveAnswer({ outcome: SaveOutcome.Saved, sameWorkGroups: [] }));
});

test("the page's refresh does not replace an entry the Lord is editing", async () => {
  const page = await openPage();
  const editor = page.editorAfterHeading('alpha-giftcard');
  retype(page.lineOf(editor, 'Kind'), 'Kind: new page — Sell gift cards');
  page.type(editor);
  page.markdown = SAMPLE_MARKDOWN.replace('on local main', 'merged to main');
  await page.refresh();
  assert.equal(page.editorAfterHeading('alpha-giftcard'), editor);
  assert.match(editor.textContent, /Sell gift cards/);
  assert.match(page.editorAfterHeading('alpha-menu').textContent, /merged to main/);
});
