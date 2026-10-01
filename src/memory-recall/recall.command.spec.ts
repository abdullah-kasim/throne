import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { recallRequestFromHookPayload } from './hook-payload.ts';
import { runRecall } from './recall.command.ts';
import {
  HOOK_PAYLOAD,
  IN_PROJECT,
  PULL_REQUEST_TASK,
  harness,
  isCompactAnswerLine,
  ledgerEntries,
  ledgerLines,
} from './recall.command.test-support.ts';
import { LOWEST_PROBABILITY_WORTH_SERVING } from './select-memories.ts';

test('recall prints the body of the matching memory and not its frontmatter, path or unrelated memories', async () => {
  const fixture = harness();
  assert.equal(await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies), 0);
  const printed = fixture.stdout.join('');
  assert.match(printed, /## NEVER_REPUBLISH\.md\n# Never republish a pull request body/);
  assert.match(printed, /it grows by a newline each time/);
  assert.doesNotMatch(printed, /cost_if_missed|ask:/);
  assert.doesNotMatch(printed, /outdated|another repository|wifi|index mentioning/);
});

test('a decision that is not a confident no lands in the ledger with its hash, pick, probability, backend and served flag', async () => {
  const fixture = harness();
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  const entries = ledgerEntries(fixture.dataDirectory).filter((entry) => !isCompactAnswerLine(entry));
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
        source: 'command',
        sessionId: null,
        arm: 'serve',
        verdict: 'memory likely exists',
        verdictConfidence: 1,
        searchedMemoryDirectories: [fixture.projectMemories, fixture.globalMemories],
        questionsAsked: 2,
        served: 1,
        confidentNoAnswersLeftOut: 0,
        everyAnswerLogged: true,
      },
    ],
  );
  assert.match(String(entries[0]?.inputHash), /^[0-9a-f]{16}$/);
  assert.equal(entries[0]?.probability, 1);
  assert.doesNotMatch(JSON.stringify(entries), /rewrite the github/);
});

test('a session is never served the same memory twice', async () => {
  const fixture = harness();
  await runRecall([...IN_PROJECT, '--session', 'session/one', PULL_REQUEST_TASK], fixture.dependencies);
  await runRecall([...IN_PROJECT, '--session', 'session/one', PULL_REQUEST_TASK], fixture.dependencies);
  await runRecall([...IN_PROJECT, '--session', 'session-two', PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(
    fixture.stdout.map((text) => text.includes('NEVER_REPUBLISH.md')),
    [true, false, true],
  );
});

test('the size cap leaves out a memory that does not fit', async () => {
  const fixture = harness({ maximumInjectedCharacters: 150 });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assert.doesNotMatch(fixture.stdout.join(''), /## NEVER_REPUBLISH\.md/);
  assert.equal(ledgerEntries(fixture.dataDirectory)[0]?.served, false);
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
  assert.doesNotMatch(fixture.stdout[1] ?? '', /NEVER_REPUBLISH\.md/);
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
  assert.equal(await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies), 0);
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
  assert.equal(await runRecall([...IN_PROJECT, '--paths', PULL_REQUEST_TASK], fixture.dependencies), 2);
  assert.match(fixture.stderr.join(''), /unknown flag "--paths"/);
  assert.deepEqual(fixture.stdout, []);
});

test('a memory directory entry that cannot be read does not stop the others being served', async () => {
  const fixture = harness();
  const { projectMemories } = fixture;
  mkdirSync(path.join(projectMemories, 'A_DIRECTORY_NAMED_LIKE_A_MEMORY.md'));
  await symlink(path.join(projectMemories, 'nowhere'), path.join(projectMemories, 'DANGLING_LINK.md'));
  assert.equal(await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies), 0);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
});

test('an unwritable data directory still prints the memories and says the record failed', async () => {
  const fixture = harness();
  const blockingFile = path.join(path.dirname(fixture.dataDirectory), 'not-a-directory');
  writeFileSync(blockingFile, '');
  const dependencies = { ...fixture.dependencies, dataDirectory: path.join(blockingFile, 'data') };
  assert.equal(await runRecall([...IN_PROJECT, '--session', 'abc', PULL_REQUEST_TASK], dependencies), 0);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
  assert.match(fixture.stderr.join(''), /record of it could not be written/);
});

test('the same directory named twice, once through a link, serves each memory once', async () => {
  const fixture = harness();
  const { projectMemories } = fixture;
  const linkToProjectMemories = path.join(path.dirname(projectMemories), 'link-to-project-memories');
  await symlink(projectMemories, linkToProjectMemories);
  const dependencies = {
    ...fixture.dependencies,
    loadConfig: async () => ({
      ...(await fixture.dependencies.loadConfig()),
      globalMemoryDirectories: [`${linkToProjectMemories}/`],
    }),
  };
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], dependencies);
  assert.equal(fixture.stdout.join('').match(/## NEVER_REPUBLISH\.md/g)?.length, 1);
});

test('a relevant memory that does not fit under the size cap is named on stderr with the size limit as its reason', async () => {
  const fixture = harness({ maximumInjectedCharacters: 150 });
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assert.equal(
    fixture.stderr.join(''),
    'recall: 1 relevant memories were not served: NEVER_REPUBLISH.md (over the size limit)\n',
  );
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
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assert.deepEqual(states, [{ task: PULL_REQUEST_TASK, repository: 'project' }]);
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
});

test('a relayed agent message ending in its message number is recalled for, like a prompt typed by the Lord', () => {
  const relayedPrompt = 'regent said: launchcheck launched: alpha-launchcheck-01 LIVE on claude/opus, sliceless. [message 4101]';
  const relayed = JSON.stringify({ prompt: relayedPrompt, session_id: 'session' });
  const ownPrompt = JSON.stringify({ prompt: 'how do we publish a pull request body?', session_id: 'session' });
  assert.deepEqual(
    [recallRequestFromHookPayload(relayed), recallRequestFromHookPayload(ownPrompt)].map((reading) =>
      'taskText' in reading ? reading.taskText : reading.skipReason,
    ),
    [relayedPrompt, 'how do we publish a pull request body?'],
  );
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
  assert.equal(await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies), 0);
  assert.doesNotMatch(fixture.stdout.join(''), /## /);
});

test('a yes at 0.41 is served and a yes at 0.39 is not', async () => {
  const servedAt = async (probability: number) => {
    const backend: ClassifierBackend = {
      name: RULES_BACKEND.name,
      answer: async (_state, questions) =>
        questions.map((question) => ({ questionId: question.id, pick: 'yes', probability })),
    };
    const fixture = harness({}, { backend });
    assert.equal(await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies), 0);
    return /## NEVER_REPUBLISH\.md/.test(fixture.stdout.join(''));
  };
  assert.deepEqual([await servedAt(0.41), await servedAt(0.39)], [true, false]);
});
