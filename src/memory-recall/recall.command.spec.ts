import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import {
  DEFAULT_RECALL_CONFIG,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import {
  recallRequestFromHookPayload,
  runRecall,
  type RecallDependencies,
} from './recall.command.ts';
import { LOWEST_PROBABILITY_WORTH_SERVING } from './select-memories.ts';
import { RECALL_LEDGER_FILE_NAME } from './recall-records.ts';

const PROJECT_SCOPE = '-home-someone-project';

const PULL_REQUEST_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  `scope: ${PROJECT_SCOPE}`,
  'kind: trap',
  'cost_if_missed: high',
  '---',
  '# Never republish a pull request body from a local file',
  '',
  '- it grows by a newline each time',
].join('\n');

const SUPERSEDED_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  'status: superseded',
  'superseded_by: NEVER_REPUBLISH.md',
  '---',
  'an outdated pull request description lesson',
].join('\n');

const OTHER_REPOSITORY_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  'scope: -home-someone-elsewhere',
  '---',
  'a pull request description lesson for another repository',
].join('\n');

const WIFI_MEMORY = '# Guard temporary wifi router changes\n\n- put the network back\n';

interface Harness {
  readonly dependencies: RecallDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly dataDirectory: string;
  backendCallCount(): number;
}

function harness(
  configOverride: Partial<RecallConfig> = {},
  options: { stdin?: string; backend?: ClassifierBackend } = {},
): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-command-'));
  const projectMemories = path.join(root, 'project-memories');
  const globalMemories = path.join(root, 'global-memories');
  const dataDirectory = path.join(root, 'data');
  mkdirSync(projectMemories);
  mkdirSync(globalMemories);
  writeFileSync(path.join(projectMemories, 'NEVER_REPUBLISH.md'), PULL_REQUEST_MEMORY);
  writeFileSync(path.join(projectMemories, 'OLD_LESSON.md'), SUPERSEDED_MEMORY);
  writeFileSync(path.join(projectMemories, 'MEMORY.md'), '# index mentioning github pull request description');
  writeFileSync(path.join(globalMemories, 'ELSEWHERE.md'), OTHER_REPOSITORY_MEMORY);
  writeFileSync(path.join(globalMemories, 'NETWORK_SAFETY.md'), WIFI_MEMORY);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let backendCalls = 0;
  const backend = options.backend ?? RULES_BACKEND;
  return {
    stdout,
    stderr,
    dataDirectory,
    backendCallCount: () => backendCalls,
    dependencies: {
      loadConfig: () =>
        Promise.resolve({
          ...DEFAULT_RECALL_CONFIG,
          globalMemoryDirectories: [globalMemories],
          ...configOverride,
        }),
      chooseBackend: () =>
        Promise.resolve<ClassifierBackend>({
          name: backend.name,
          answer: (state, questions) => {
            backendCalls += 1;
            return backend.answer(state, questions);
          },
        }),
      readJevSwitch: () =>
        Promise.resolve({
          on: false,
          enabledInConfig: false,
          disabledByEnvironment: false,
          keyFile: 'not-checked',
          keyFilePath: '/keys/jev',
        }),
      resolveProjectMemoryDirectory: () =>
        Promise.resolve({
          path: projectMemories,
          repositoryName: 'project',
          repositoryScopes: [PROJECT_SCOPE, 'project'],
        }),
      readStdin: () => Promise.resolve(options.stdin ?? ''),
      currentDirectory: () => root,
      dataDirectory,
      now: () => new Date('2026-09-21T00:00:00Z'),
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

function ledgerLines(dataDirectory: string): Record<string, unknown>[] {
  return readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function ledgerEntries(dataDirectory: string): Record<string, unknown>[] {
  return ledgerLines(dataDirectory).filter((line) => 'questionId' in line);
}

const PULL_REQUEST_TASK = 'rewrite the github pull request description for the fix';

test('recall prints the body of the matching memory and not its frontmatter, path or unrelated memories', async () => {
  const fixture = harness();
  assert.equal(await runRecall([PULL_REQUEST_TASK], fixture.dependencies), 0);
  const printed = fixture.stdout.join('');
  assert.match(printed, /## NEVER_REPUBLISH\.md\n# Never republish a pull request body/);
  assert.match(printed, /it grows by a newline each time/);
  assert.doesNotMatch(printed, /cost_if_missed|ask:/);
  assert.doesNotMatch(printed, /outdated|another repository|wifi|index mentioning/);
});

test('every decision lands in the ledger with its hash, pick, probability, backend and served flag', async () => {
  const fixture = harness();
  await runRecall([PULL_REQUEST_TASK], fixture.dependencies);
  const entries = ledgerEntries(fixture.dataDirectory);
  assert.deepEqual(
    entries.map((entry) => [path.basename(String(entry.questionId)), entry.pick, entry.served, entry.backend]),
    [['NEVER_REPUBLISH.md', 'yes', true, 'rules']],
  );
  assert.deepEqual(
    ledgerLines(fixture.dataDirectory).filter((line) => 'questionsAsked' in line),
    [
      {
        at: '2026-09-21T00:00:00.000Z',
        inputHash: entries[0]?.inputHash,
        questionsAsked: 2,
        served: 1,
        confidentNoAnswersLeftOut: 1,
      },
    ],
  );
  assert.match(String(entries[0]?.inputHash), /^[0-9a-f]{16}$/);
  assert.equal(entries[0]?.probability, 1);
  assert.doesNotMatch(JSON.stringify(entries), /rewrite the github/);
});

test('a session is never served the same memory twice', async () => {
  const fixture = harness();
  await runRecall(['--session', 'session/one', PULL_REQUEST_TASK], fixture.dependencies);
  await runRecall(['--session', 'session/one', PULL_REQUEST_TASK], fixture.dependencies);
  await runRecall(['--session', 'session-two', PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(
    fixture.stdout.map((text) => text.includes('NEVER_REPUBLISH.md')),
    [true, false, true],
  );
});

test('the size cap leaves out a memory that does not fit', async () => {
  const fixture = harness({ maximumInjectedCharacters: 150 });
  await runRecall([PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(fixture.stdout, ['']);
  assert.equal(ledgerEntries(fixture.dataDirectory)[0]?.served, false);
});

const HOOK_PAYLOAD = JSON.stringify({
  session_id: 'abc',
  cwd: '/somewhere',
  hook_event_name: 'UserPromptSubmit',
  prompt: PULL_REQUEST_TASK,
});

test('hook mode with the hook switched off prints nothing, asks nothing and exits zero', async () => {
  const fixture = harness({ hookEnabled: false }, { stdin: HOOK_PAYLOAD });
  assert.equal(await runRecall(['--hook'], fixture.dependencies), 0);
  assert.deepEqual(fixture.stdout, []);
  assert.equal(fixture.backendCallCount(), 0);
});

test('hook mode with the hook switched on serves the prompt from the payload once per session', async () => {
  const fixture = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  assert.equal(await runRecall(['--hook'], fixture.dependencies), 0);
  assert.equal(await runRecall(['--hook'], fixture.dependencies), 0);
  assert.match(fixture.stdout[0] ?? '', /^Recalled memories/);
  assert.match(fixture.stdout[0] ?? '', /NEVER_REPUBLISH\.md/);
  assert.equal(fixture.stdout[1], '');
});

for (const [situation, stdin] of [
  ['is not JSON', 'not json at all'],
  ['has no prompt', '{"session_id":"abc"}'],
] as const) {
  test(`hook mode with a payload that ${situation} prints nothing and exits zero`, async () => {
    const fixture = harness({ hookEnabled: true }, { stdin });
    assert.equal(await runRecall(['--hook'], fixture.dependencies), 0);
    assert.deepEqual(fixture.stdout, []);
  });
}

test('hook mode exits zero and prints nothing even when the config cannot be loaded', async () => {
  const fixture = harness({ hookEnabled: true }, { stdin: HOOK_PAYLOAD });
  const dependencies = { ...fixture.dependencies, loadConfig: () => Promise.reject(new Error('broken config')) };
  assert.equal(await runRecall(['--hook'], dependencies), 0);
  assert.deepEqual(fixture.stdout, []);
  assert.match(fixture.stderr.join(''), /broken config/);
});

test('a failing model backend falls back to the rules and still serves the right memory', async () => {
  const failingJev: ClassifierBackend = {
    name: 'jev',
    answer: () => Promise.reject(Object.assign(new Error('slow down'), { status: 429 })),
  };
  const fixture = harness({}, { backend: failingJev });
  assert.equal(await runRecall([PULL_REQUEST_TASK], fixture.dependencies), 0);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
  assert.doesNotMatch(fixture.stdout.join(''), /wifi/);
  assert.deepEqual(
    ledgerEntries(fixture.dataDirectory).map((entry) => [entry.backend, entry.failedOpen]),
    [
      ['rules', true],
      ['rules', true],
    ],
  );
  assert.match(fixture.stderr.join(''), /HTTP 429/);
});

test('recall without task text is refused with the usage', async () => {
  const fixture = harness();
  assert.equal(await runRecall([], fixture.dependencies), 2);
  assert.match(fixture.stderr.join(''), /Usage: .*recall/);
});

test('an unknown flag is a steered exit 2', async () => {
  const fixture = harness();
  assert.equal(await runRecall(['--paths', PULL_REQUEST_TASK], fixture.dependencies), 2);
  assert.match(fixture.stderr.join(''), /unknown flag "--paths"/);
  assert.deepEqual(fixture.stdout, []);
});

test('a memory directory entry that cannot be read does not stop the others being served', async () => {
  const fixture = harness();
  const projectMemories = (await fixture.dependencies.resolveProjectMemoryDirectory(''))?.path ?? '';
  mkdirSync(path.join(projectMemories, 'A_DIRECTORY_NAMED_LIKE_A_MEMORY.md'));
  await symlink(path.join(projectMemories, 'nowhere'), path.join(projectMemories, 'DANGLING_LINK.md'));
  assert.equal(await runRecall([PULL_REQUEST_TASK], fixture.dependencies), 0);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
});

test('an unwritable data directory still prints the memories and says the record failed', async () => {
  const fixture = harness();
  const blockingFile = path.join(path.dirname(fixture.dataDirectory), 'not-a-directory');
  writeFileSync(blockingFile, '');
  const dependencies = { ...fixture.dependencies, dataDirectory: path.join(blockingFile, 'data') };
  assert.equal(await runRecall(['--session', 'abc', PULL_REQUEST_TASK], dependencies), 0);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
  assert.match(fixture.stderr.join(''), /record of it could not be written/);
});

test('the same directory named twice, once through a link, serves each memory once', async () => {
  const fixture = harness();
  const projectMemories = (await fixture.dependencies.resolveProjectMemoryDirectory(''))?.path ?? '';
  const linkToProjectMemories = path.join(path.dirname(projectMemories), 'link-to-project-memories');
  await symlink(projectMemories, linkToProjectMemories);
  const dependencies = {
    ...fixture.dependencies,
    loadConfig: async () => ({
      ...(await fixture.dependencies.loadConfig()),
      globalMemoryDirectories: [`${linkToProjectMemories}/`],
    }),
  };
  await runRecall([PULL_REQUEST_TASK], dependencies);
  assert.equal(fixture.stdout.join('').match(/## NEVER_REPUBLISH\.md/g)?.length, 1);
});

test('a relevant memory that does not fit under the size cap is named on stderr', async () => {
  const fixture = harness({ maximumInjectedCharacters: 150 });
  await runRecall([PULL_REQUEST_TASK], fixture.dependencies);
  assert.match(fixture.stderr.join(''), /1 relevant memories did not fit.*NEVER_REPUBLISH\.md/);
});

test('--status says which backend would answer and why, and asks nothing', async () => {
  const fixture = harness();
  assert.equal(await runRecall(['--status'], fixture.dependencies), 0);
  assert.match(fixture.stdout.join(''), /backend that would answer now: rules\nwhy: recall\.jevEnabled is false/);
  assert.equal(fixture.backendCallCount(), 0);
});

test('the model backend is given the task and the repository as named fields', async () => {
  const states: unknown[] = [];
  const recordingBackend: ClassifierBackend = {
    name: 'jev',
    answer: (state, questions) => {
      states.push(state);
      return RULES_BACKEND.answer(state, questions);
    },
  };
  const fixture = harness({}, { backend: recordingBackend });
  await runRecall([PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(states, [{ task: PULL_REQUEST_TASK, repository: 'project' }]);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
});

test('a relayed agent message ending in its message number is not recalled for, and a prompt typed by the Lord still is', () => {
  const relayed = JSON.stringify({
    prompt: 'regent said: launchcheck launched: alpha-launchcheck-01 LIVE on claude/opus, sliceless. [message 4101]',
    session_id: 'session',
  });
  const ownPrompt = JSON.stringify({ prompt: 'how do we publish a pull request body?', session_id: 'session' });
  assert.equal(recallRequestFromHookPayload(relayed), undefined);
  assert.equal(recallRequestFromHookPayload(ownPrompt)?.taskText, 'how do we publish a pull request body?');
});

test('a yes answered below the serving probability is judged but not served', async () => {
  const unsure: ClassifierBackend = {
    name: RULES_BACKEND.name,
    answer: async (_state, questions) =>
      questions.map((question) => ({
        questionId: question.id,
        pick: 'yes',
        probability: LOWEST_PROBABILITY_WORTH_SERVING - 0.1,
      })),
  };
  const fixture = harness({}, { backend: unsure });
  assert.equal(await runRecall([PULL_REQUEST_TASK], fixture.dependencies), 0);
  assert.equal(fixture.stdout.join(''), '');
});
