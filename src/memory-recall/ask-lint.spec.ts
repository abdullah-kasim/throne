import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  BARE_NARROW_ASK,
  BARE_REPOSITORY_NAME,
  GENERAL_COMPUTING_TERM,
  KEPT_NARROW_TRIGGER,
  MISSING_ASK,
  REPOSITORY_WIDE_NOUN,
  TOKEN_AREA,
  TRIGGER_LEAD_IN,
  VERB_ENDING_FRAGMENT,
  type AskLintRule,
} from './ask-lint-rules.ts';
import { lintAsks, projectMemoryDirectoriesToLint } from './ask-lint.ts';
import {
  memoryDirectoryWith,
  memoryWithAsk,
  rulesFlaggedFor,
  temporaryRoot,
} from './ask-lint.test-support.ts';

function houseAsk(area: string): string {
  return `Does the task touch ${area} in any way?`;
}

async function assertFlags(rule: AskLintRule, asks: readonly string[], repositoryName?: string): Promise<void> {
  for (const [ask, rules] of await rulesFlaggedFor(asks, repositoryName)) {
    assert.ok(rules.includes(rule), `${rule} should flag: ${ask} (got ${rules.join(', ') || 'nothing'})`);
  }
}

async function assertPasses(asks: readonly string[], repositoryName?: string): Promise<void> {
  for (const [ask, rules] of await rulesFlaggedFor(asks, repositoryName)) {
    assert.deepEqual(rules, [], `should pass: ${ask}`);
  }
}

const GOOD_AREAS = [
  'the orchard-shop test sites and their crawlers',
  "bakery-admin's lint",
  "throne's gh guard on the enterprise host",
  'trunk merge',
  'Orchard routes',
  'the recall ask audit',
];

test('every lesson-approved area in the house form passes every rule', async () => {
  await assertPasses(GOOD_AREAS.map(houseAsk), 'throne');
  await assertPasses(['Does the task involve the recall ask audit?', 'Is the task about Orchard routes?']);
});

test('missing-ask flags a memory with no ask and stays silent on one with an ask', async () => {
  const directory = await memoryDirectoryWith(
    { 'NO_ASK.md': memoryWithAsk(undefined), 'EMPTY_ASK.md': memoryWithAsk(''), 'ASKED.md': memoryWithAsk(houseAsk('trunk merge')) },
    path.join(await temporaryRoot(), 'memories'),
  );
  const { violations } = await lintAsks([{ path: directory, repositoryName: undefined }]);
  assert.deepEqual(
    violations.map((violation) => [path.basename(violation.filePath), violation.rule, violation.ask]),
    [
      ['EMPTY_ASK.md', MISSING_ASK, undefined],
      ['NO_ASK.md', MISSING_ASK, undefined],
    ],
  );
});

test('bare-narrow-ask flags a question led by one action on the subject and not the house forms', async () => {
  await assertFlags(BARE_NARROW_ASK, [
    'Does the task start the crawlers for the orchard-shop test sites?',
    'Does the task merge a pull request?',
    'Before any git commit in the repository.',
  ]);
  await assertPasses([houseAsk('trunk merge'), 'Does the task involve trunk merge?', 'Is the task about trunk merge?']);
});

test('kept-narrow-trigger flags a second sentence without the lead-in and passes one with it', async () => {
  await assertFlags(KEPT_NARROW_TRIGGER, [
    `${houseAsk('the orchard-shop test sites and their crawlers')} Does it start them with make up?`,
    `${houseAsk('the orchard-shop test sites and their crawlers')} For example: starting them.`,
  ]);
  await assertPasses([
    `${houseAsk('the orchard-shop test sites and their crawlers')} ${TRIGGER_LEAD_IN} starting them.`,
    'Is the task about the query page proxy, e.g. one that pads the site list?',
  ]);
});

test('token-area flags code tokens named by the lessons and passes plain areas', async () => {
  await assertFlags(TOKEN_AREA, [
    houseAsk('`npm run lint`'),
    houseAsk('trace-filter-visibility.spec.js'),
    houseAsk('ZREM'),
    houseAsk('agent-browser 0.37'),
    houseAsk('drawWaterfall'),
    houseAsk("orchard-shop's unstack128"),
    houseAsk('the tidy report (recall --tidy-report)'),
    houseAsk('src/memory-recall/ask-lint.ts'),
    houseAsk('npm run lint'),
    houseAsk('RECALL_LEDGER_FILE_NAME'),
  ]);
  await assertPasses([
    houseAsk("throne's gh guard on the enterprise host"),
    houseAsk('the podman applehv VM'),
    houseAsk('git author email'),
  ]);
});

test('bare-repository-name flags the memory directory repository name alone or as its repo', async () => {
  await assertFlags(BARE_REPOSITORY_NAME, [houseAsk('throne'), houseAsk('the throne repo'), houseAsk('throne codebase')], 'throne');
  await assertFlags(BARE_REPOSITORY_NAME, [houseAsk('orchard-shop')], 'orchard-shop');
  await assertPasses([houseAsk('orchard-shop')], 'throne');
  await assertPasses([houseAsk("throne's gh guard on the enterprise host")], 'throne');
});

test('a global memory has no repository name, so bare-repository-name never flags it', async () => {
  await assertPasses([houseAsk('orchard-shop')], undefined);
});

test('repository-wide-noun flags an area whose head noun names the whole repository', async () => {
  await assertFlags(REPOSITORY_WIDE_NOUN, [
    houseAsk('orchard-shop PR branch'),
    houseAsk("throne's worktree"),
    houseAsk('queue row'),
    houseAsk('Shadow slice'),
    houseAsk('orchard-shop trunk'),
    houseAsk('separate pull requests'),
    houseAsk("the Regent's branches"),
    houseAsk('the recall ask audit or its commits'),
  ]);
  await assertPasses([houseAsk('trunk merge'), houseAsk('the commit guard on message words')]);
});

test('verb-ending-fragment flags an area cut from a sentence at its verb', async () => {
  await assertFlags(VERB_ENDING_FRAGMENT, [
    houseAsk('Orchard never sees'),
    houseAsk('spawn-git-tree can fork'),
    houseAsk('orchard-shop trunk needs'),
    houseAsk('query UI picks'),
    houseAsk("throne's fork refuses"),
    houseAsk('how memory asks are judged'),
  ]);
  await assertPasses([houseAsk('Orchard routes')]);
});

test('general-computing-term flags a bare general term and passes a qualified one', async () => {
  await assertFlags(GENERAL_COMPUTING_TERM, [
    houseAsk('env vars'),
    houseAsk('file paths'),
    houseAsk('test fixtures'),
    houseAsk('markdown'),
    houseAsk('JSON'),
    houseAsk('the tests'),
  ]);
  await assertPasses([houseAsk("bakery-admin's lint"), houseAsk('the recall report markdown')]);
});

test('the lint reports every violation of a memory in rule order and sorts memories by path', async () => {
  const directory = await memoryDirectoryWith(
    {
      'B_SECOND.md': memoryWithAsk(`${houseAsk('throne')} Does it run npm test?`),
      'A_FIRST.md': memoryWithAsk('Does the task run the tests?'),
    },
    path.join(await temporaryRoot(), 'memories'),
  );
  const result = await lintAsks([{ path: directory, repositoryName: 'throne' }]);
  assert.deepEqual(
    result.violations.map((violation) => [path.basename(violation.filePath), violation.rule]),
    [
      ['A_FIRST.md', BARE_NARROW_ASK],
      ['B_SECOND.md', KEPT_NARROW_TRIGGER],
      ['B_SECOND.md', BARE_REPOSITORY_NAME],
    ],
  );
  assert.equal(result.memoriesFlagged, 2);
  assert.equal(result.memoriesRead, 2);
  assert.equal(result.directoriesRead, 1);
});

test('the lint skips superseded memories and the index and readme files', async () => {
  const directory = await memoryDirectoryWith(
    {
      'OLD.md': ['---', 'ask: Does the task run the tests?', 'status: superseded', '---', 'old'].join('\n'),
      'MEMORY.md': '# index',
      'README.md': '# readme',
    },
    path.join(await temporaryRoot(), 'memories'),
  );
  const result = await lintAsks([{ path: directory, repositoryName: undefined }]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.memoriesRead, 0);
});

test('the lint never edits a memory: bytes, modification times and directory listing stay the same', async () => {
  const directory = await memoryDirectoryWith(
    {
      'FLAGGED.md': memoryWithAsk('Does the task run the tests?'),
      'NO_ASK.md': memoryWithAsk(undefined),
      'CLEAN.md': memoryWithAsk(houseAsk('trunk merge')),
    },
    path.join(await temporaryRoot(), 'memories'),
  );
  const snapshotOf = async (): Promise<readonly (readonly [string, string, number])[]> =>
    Promise.all(
      (await readdir(directory)).sort().map(async (fileName) => {
        const filePath = path.join(directory, fileName);
        return [fileName, await readFile(filePath, 'utf8'), (await stat(filePath)).mtimeMs] as const;
      }),
    );
  const before = await snapshotOf();
  const directoryModifiedBefore = (await stat(directory)).mtimeMs;
  await lintAsks([{ path: directory, repositoryName: undefined }]);
  assert.deepEqual(await snapshotOf(), before);
  assert.equal((await stat(directory)).mtimeMs, directoryModifiedBefore);
});

test('the default scope is every directory under the home memory root, each named after its repository', async () => {
  const root = await temporaryRoot();
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'repos', 'orchard-shop');
  const hiddenCheckout = path.join(root, 'Development', 'bakery-dashboard', '.bare');
  await mkdir(checkout, { recursive: true });
  await mkdir(hiddenCheckout, { recursive: true });
  const slugOf = (directory: string): string => directory.split(path.sep).join('-');
  const memoryRoot = path.join(home, '.memories');
  await mkdir(path.join(memoryRoot, slugOf(checkout)), { recursive: true });
  await mkdir(path.join(memoryRoot, slugOf(hiddenCheckout)), { recursive: true });
  await mkdir(path.join(memoryRoot, '-no-such-place-anywhere'), { recursive: true });

  const directories = await projectMemoryDirectoriesToLint(home);
  assert.deepEqual(
    directories.map((directory) => [path.basename(directory.path), directory.repositoryName]),
    [
      ['-no-such-place-anywhere', undefined],
      [slugOf(hiddenCheckout), 'bakery-dashboard'],
      [slugOf(checkout), 'orchard-shop'],
    ].sort((left, right) => ((left[0] as string) < (right[0] as string) ? -1 : 1)),
  );
});
