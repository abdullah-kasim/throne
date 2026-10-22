import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { PAGE_FILE, pageScriptsInOrder } from './where-i-stand-page-scripts.support.ts';

const PAGE_ADDRESS_NAMING_THE_PAGE_FILE = 'http://127.0.0.1:8080/where-i-stand/index.html';
const PAGE_ADDRESS_WITH_A_TRAILING_SLASH = 'http://127.0.0.1:8080/where-i-stand/';
const PAGE_ADDRESS_WITHOUT_A_TRAILING_SLASH = 'http://127.0.0.1:8080/where-i-stand';
const MARKDOWN_FILE_BESIDE_THE_PAGE = 'http://127.0.0.1:8080/where-i-stand/where-i-stand.md';
const RECORDS_FILE_BESIDE_THE_PAGE = 'http://127.0.0.1:8080/where-i-stand/where-i-stand-prs.json';
const BOTH_FILES_BESIDE_THE_PAGE = [MARKDOWN_FILE_BESIDE_THE_PAGE, RECORDS_FILE_BESIDE_THE_PAGE];
const SCRIPT_ELEMENTS = /<script>[\s\S]*?<\/script>|<script src="[\w-]+\.js"><\/script>/g;

const MARKUP_THAT_LOADS_A_RESOURCE = [
  /\ssrc\s*=/i,
  /\ssrcset\s*=/i,
  /\shref\s*=/i,
  /<link\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /url\(/i,
  /@import/i,
];

const SCRIPT_THAT_LOADS_A_RESOURCE = [
  /\bimport\s*\(/,
  /\bimportScripts\b/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\bnew Image\b/,
];

const ADDRESS_ON_ANOTHER_ORIGIN = /[a-z][a-z0-9+.-]*:\/\/|["'(=\s]\/\/[a-z0-9]/i;

const page = await readFile(PAGE_FILE, 'utf8');
const pageScripts = await pageScriptsInOrder();
const pageScript = pageScripts.join('\n');
const pageMarkupAndStyle = page.replace(SCRIPT_ELEMENTS, '');

function browserObjectThatAcceptsEveryCall(knownProperties: Record<string, unknown> = {}): unknown {
  const browserObject: unknown = new Proxy(function browserFunction() {}, {
    get: (_target, property) => {
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return knownProperties[property] ?? browserObject;
    },
    set: () => true,
    apply: () => browserObject,
  });
  return browserObject;
}

async function pageOpenedAt(pageAddress: string): Promise<{ fetchedAddresses: string[]; movedTo: string[] }> {
  const fetchedAddresses: string[] = [];
  const movedTo: string[] = [];
  const { pathname, search, hash } = new URL(pageAddress);
  const location = { pathname, search, hash, replace: (address: string) => movedTo.push(address) };
  const browser = vm.createContext({
    document: browserObjectThatAcceptsEveryCall({ baseURI: pageAddress }),
    window: browserObjectThatAcceptsEveryCall({ location }),
    URL,
    setInterval: () => 0,
    fetch: async (address: string) => {
      fetchedAddresses.push(address);
      return new Response('## Needs you\n\n- Approve the rye flour order\n', {
        headers: { 'Last-Modified': 'Wed, 14 Oct 2026 04:00:00 GMT' },
      });
    },
  });
  for (const script of pageScripts) await vm.runInContext(script, browser);
  return { fetchedAddresses, movedTo };
}

async function addressesThePageFetches(pageAddress: string): Promise<string[]> {
  return (await pageOpenedAt(pageAddress)).fetchedAddresses;
}

function patternsFoundIn(text: string, patterns: RegExp[]): string[] {
  return patterns.filter((pattern) => pattern.test(text)).map(String);
}

test('the where-i-stand page loads nothing from a network', async () => {
  assert.notEqual(pageScript, '', 'the page carries its script inline');
  assert.deepEqual(patternsFoundIn(pageMarkupAndStyle, MARKUP_THAT_LOADS_A_RESOURCE), []);
  assert.deepEqual(patternsFoundIn(pageScript, SCRIPT_THAT_LOADS_A_RESOURCE), []);
  assert.deepEqual(patternsFoundIn(page, [ADDRESS_ON_ANOTHER_ORIGIN]), []);
  assert.deepEqual(patternsFoundIn(pageScript, [ADDRESS_ON_ANOTHER_ORIGIN]), []);
  assert.equal(
    (await addressesThePageFetches(PAGE_ADDRESS_NAMING_THE_PAGE_FILE)).length,
    2,
    'the only requests are the ones for the Markdown file and the pull request records',
  );
});

test('the where-i-stand page fetches the Markdown file and the pull request records from its own folder', async () => {
  assert.deepEqual(await addressesThePageFetches(PAGE_ADDRESS_NAMING_THE_PAGE_FILE), BOTH_FILES_BESIDE_THE_PAGE);
  assert.deepEqual(await addressesThePageFetches(PAGE_ADDRESS_WITH_A_TRAILING_SLASH), BOTH_FILES_BESIDE_THE_PAGE);
});

test('the where-i-stand page finds both files when opened without a trailing slash', async () => {
  assert.deepEqual(await addressesThePageFetches(PAGE_ADDRESS_WITHOUT_A_TRAILING_SLASH), BOTH_FILES_BESIDE_THE_PAGE);
});

test('the where-i-stand page opened without a trailing slash moves to its folder address so its scripts load from that folder', async () => {
  assert.deepEqual((await pageOpenedAt(`${PAGE_ADDRESS_WITHOUT_A_TRAILING_SLASH}?from=phone#needs-you`)).movedTo, ['/where-i-stand/?from=phone#needs-you']);
  assert.deepEqual((await pageOpenedAt(PAGE_ADDRESS_WITH_A_TRAILING_SLASH)).movedTo, []);
  assert.deepEqual((await pageOpenedAt(PAGE_ADDRESS_NAMING_THE_PAGE_FILE)).movedTo, []);
});
