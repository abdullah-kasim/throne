import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { CORRECTION_QUESTION_ID } from './correction-question.ts';
import { MEMORY_VERSIONS_DIRECTORY_NAME, contentHashOf } from './memory-versions.ts';
import type { RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { runRecall } from './recall.command.ts';
import {
  IN_PROJECT,
  PULL_REQUEST_TASK,
  harness,
  isCompactAnswerLine,
  ledgerLines,
  sureNoBackend,
} from './recall.command.test-support.ts';
import {
  PROMPT_LOG_FILE_NAME,
  inputHash,
} from './recall-records.ts';

function hookPayload(prompt: string, sessionId: string, transcriptPath?: string): string {
  return JSON.stringify({
    session_id: sessionId,
    cwd: '/somewhere',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  });
}

function hookFixture(
  configOverride: Partial<RecallConfig>,
  options: { backend?: ClassifierBackend } = {},
) {
  const fixture = harness({ hookEnabled: true, ...configOverride }, options);
  async function promptHook(prompt: string, sessionId: string): Promise<number> {
    return runRecall(['--hook'], {
      ...fixture.dependencies,
      readStdin: () => Promise.resolve(hookPayload(prompt, sessionId)),
    });
  }
  return { ...fixture, promptHook };
}

function summaryLines(dataDirectory: string): Record<string, unknown>[] {
  return ledgerLines(dataDirectory).filter((line) => 'questionsAsked' in line);
}

function decisionLines(dataDirectory: string): Record<string, unknown>[] {
  return ledgerLines(dataDirectory).filter((line) => 'questionId' in line);
}

function fullDecisionLines(dataDirectory: string): Record<string, unknown>[] {
  return decisionLines(dataDirectory).filter((line) => !isCompactAnswerLine(line));
}

function promptLogLines(dataDirectory: string): Record<string, unknown>[] {
  return readFileSync(path.join(dataDirectory, PROMPT_LOG_FILE_NAME), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const NOT_A_CORRECTION_BY_RULES = { pick: 'no', probability: 1, backend: 'rules', failedOpen: false };

const SPLIT_SESSIONS = Array.from({ length: 20 }, (_, index) => `session-${index}`);

test('every prompt the hook sees is written to the prompt log with its session, time, first 2000 characters and input hash', async () => {
  const fixture = hookFixture({});
  const longPrompt = `${PULL_REQUEST_TASK} ${'and more detail '.repeat(200)}`;
  await fixture.promptHook(longPrompt, 'session-long');
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-short');
  assert.deepEqual(promptLogLines(fixture.dataDirectory), [
    {
      at: '2026-09-21T00:00:00.000Z',
      sessionId: 'session-long',
      inputHash: inputHash(longPrompt),
      prompt: longPrompt.slice(0, 2000),
      promptKind: 'typed',
      searchedMemoryDirectories: [fixture.projectMemories, fixture.globalMemories],
      transcriptPath: null,
      correction: NOT_A_CORRECTION_BY_RULES,
    },
    {
      at: '2026-09-21T00:00:00.000Z',
      sessionId: 'session-short',
      inputHash: inputHash(PULL_REQUEST_TASK),
      prompt: PULL_REQUEST_TASK,
      promptKind: 'typed',
      searchedMemoryDirectories: [fixture.projectMemories, fixture.globalMemories],
      transcriptPath: null,
      correction: NOT_A_CORRECTION_BY_RULES,
    },
  ]);
  assert.equal((promptLogLines(fixture.dataDirectory)[0]?.prompt as string).length, 2000);
  assert.deepEqual(
    summaryLines(fixture.dataDirectory).map((line) => [line.at, line.inputHash, line.source]),
    [
      ['2026-09-21T00:00:00.000Z', inputHash(longPrompt), 'hook'],
      ['2026-09-21T00:00:00.000Z', inputHash(PULL_REQUEST_TASK), 'hook'],
    ],
  );
});

const DIRECT_RELAY = `alpha-one said: ${PULL_REQUEST_TASK}. [message 12]`;
const PASTED_RELAY = [
  '',
  '<pasted_content id="ab12">',
  `alpha-one said: ${PULL_REQUEST_TASK}, then report`,
  '</pasted_content id="ab12">',
  '',
  ' back to me. [message 13]',
].join('\n');
const PASTED_OPENING_PROMPT = [
  '<pasted_content id="cd34">',
  `You are shadow-one. ${PULL_REQUEST_TASK}. [message 14]`,
  '</pasted_content id="cd34">',
].join('\n');
const TASK_NOTIFICATION = [
  '<task-notification>',
  '<task-id>b1</task-id>',
  `<summary>Background command "${PULL_REQUEST_TASK}" completed (exit code 0)</summary>`,
  '</task-notification>',
].join('\n');
const PASTED_BY_THE_PERSON = `<pasted_content id="ef56">\n${PULL_REQUEST_TASK}\n</pasted_content id="ef56">`;
const SLASH_COMMAND_EXPANSION = `<command-message>pr-description</command-message>\n<command-name>/pr-description</command-name>\n${PULL_REQUEST_TASK}`;

test('a pasted relay, a direct relay and a task notification are all judged and written to the prompt log', async () => {
  const fixture = hookFixture({ hookMode: 'serve' });
  for (const [index, prompt] of [PASTED_RELAY, DIRECT_RELAY, TASK_NOTIFICATION].entries()) {
    await fixture.promptHook(prompt, `session-relay-${index}`);
  }
  assert.equal(fixture.backendCallCount(), 3);
  assert.equal(fixture.stdout.filter((text) => text.includes('NEVER_REPUBLISH.md')).length, 3);
  assert.deepEqual(
    promptLogLines(fixture.dataDirectory).map((line) => line.inputHash),
    [PASTED_RELAY, DIRECT_RELAY, TASK_NOTIFICATION].map(inputHash),
  );
  assert.deepEqual(
    summaryLines(fixture.dataDirectory).map((line) => line.inputHash),
    [PASTED_RELAY, DIRECT_RELAY, TASK_NOTIFICATION].map(inputHash),
  );
});

test('each prompt is recorded with its kind: typed, relayed, task-notification or other', async () => {
  const fixture = hookFixture({ hookMode: 'shadow' });
  const promptsAndKinds = [
    [PULL_REQUEST_TASK, 'typed'],
    [PASTED_BY_THE_PERSON, 'typed'],
    [DIRECT_RELAY, 'relayed'],
    [PASTED_RELAY, 'relayed'],
    [PASTED_OPENING_PROMPT, 'relayed'],
    [TASK_NOTIFICATION, 'task-notification'],
    [SLASH_COMMAND_EXPANSION, 'other'],
  ] as const;
  for (const [index, [prompt]] of promptsAndKinds.entries()) {
    await fixture.promptHook(prompt, `session-kind-${index}`);
  }
  const expectedKinds = promptsAndKinds.map(([, kind]) => kind);
  assert.deepEqual(promptLogLines(fixture.dataDirectory).map((line) => line.promptKind), expectedKinds);
  assert.deepEqual(summaryLines(fixture.dataDirectory).map((line) => line.promptKind), expectedKinds);
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  assert.equal('promptKind' in (summaryLines(fixture.dataDirectory).at(-1) ?? {}), false);
});

function neverAnsweringJev(): ClassifierBackend {
  return { name: 'jev', answer: () => new Promise<never>(() => undefined) };
}

function failingJev(): ClassifierBackend {
  return { name: 'jev', answer: () => Promise.reject(Object.assign(new Error('slow down'), { status: 429 })) };
}

const HOOK_TIMEOUT_FOR_TESTS = 20;

function hookRunsOf(dataDirectory: string): Record<string, unknown>[] {
  return ledgerLines(dataDirectory).filter((line) => 'hookOutcome' in line);
}

test('every hook run records how long it took and whether it served, found nothing relevant, timed out, hit a classifier error or was skipped with its reason', async () => {
  const outcomeOf = async (
    configOverride: Partial<RecallConfig>,
    options: { backend?: ClassifierBackend; stdin?: string } = {},
  ) => {
    const fixture = hookFixture({ hookTimeoutMilliseconds: HOOK_TIMEOUT_FOR_TESTS, ...configOverride }, options);
    const exitCode = await runRecall(['--hook'], {
      ...fixture.dependencies,
      readStdin: () => Promise.resolve(options.stdin ?? hookPayload(PULL_REQUEST_TASK, 'session-outcome')),
    });
    assert.equal(exitCode, 0);
    const runs = hookRunsOf(fixture.dataDirectory);
    assert.equal(runs.length, 1);
    const [run] = runs as [Record<string, unknown>];
    assert.equal(typeof run.hookDurationMilliseconds, 'number');
    assert.ok(Number(run.hookDurationMilliseconds) >= 0);
    return run;
  };
  const pick = (run: Record<string, unknown>) => [run.hookOutcome, run.hookSkipReason, run.sessionId];

  assert.deepEqual(pick(await outcomeOf({ hookMode: 'serve' })), ['served', undefined, 'session-outcome']);
  assert.deepEqual(pick(await outcomeOf({ hookMode: 'shadow' })), ['served', undefined, 'session-outcome']);
  assert.deepEqual(
    pick(await outcomeOf({ hookMode: 'serve' }, { backend: sureNoBackend(0.95) })),
    ['nothing relevant', undefined, 'session-outcome'],
  );
  const timedOut = await outcomeOf({ hookMode: 'serve' }, { backend: neverAnsweringJev() });
  assert.deepEqual(pick(timedOut), ['timed out', undefined, 'session-outcome']);
  assert.ok(Number(timedOut.hookDurationMilliseconds) >= HOOK_TIMEOUT_FOR_TESTS);
  assert.deepEqual(
    pick(await outcomeOf({ hookMode: 'serve' }, { backend: failingJev() })),
    ['classifier error', undefined, 'session-outcome'],
  );
  assert.deepEqual(pick(await outcomeOf({ hookEnabled: false })), ['skipped', 'hook disabled', 'session-outcome']);
  assert.deepEqual(pick(await outcomeOf({}, { stdin: 'not json at all' })), ['skipped', 'unreadable payload', null]);
  assert.deepEqual(
    pick(await outcomeOf({}, { stdin: JSON.stringify({ session_id: 'session-empty', prompt: '  ' }) })),
    ['skipped', 'empty prompt', 'session-empty'],
  );
});

test('a hook run that fails outright is recorded as skipped because the hook failed', async () => {
  const fixture = hookFixture({});
  await runRecall(['--hook'], {
    ...fixture.dependencies,
    loadConfig: () => Promise.reject(new Error('broken config')),
    readStdin: () => Promise.resolve(hookPayload(PULL_REQUEST_TASK, 'session-broken')),
  });
  assert.deepEqual(
    hookRunsOf(fixture.dataDirectory).map((run) => [run.hookOutcome, run.hookSkipReason, run.sessionId]),
    [['skipped', 'hook failed', 'session-broken']],
  );
});

test('while the hook is switched off nothing is judged or printed, and the run is recorded as skipped because the hook is off', async () => {
  const fixture = hookFixture({ hookEnabled: false, hookMode: 'split' });
  assert.equal(await fixture.promptHook(PULL_REQUEST_TASK, 'session-off'), 0);
  assert.equal(fixture.backendCallCount(), 0);
  assert.deepEqual(fixture.stdout, []);
  assert.deepEqual(fixture.stderr, []);
  assert.equal(existsSync(path.join(fixture.dataDirectory, PROMPT_LOG_FILE_NAME)), false);
  assert.deepEqual(
    ledgerLines(fixture.dataDirectory).map((line) => [line.source, line.hookOutcome, line.hookSkipReason]),
    [['hook', 'skipped', 'hook disabled']],
  );
});

test('shadow mode injects nothing but records what would have been served', async () => {
  const fixture = hookFixture({ hookMode: 'shadow' });
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-shadow');
  assert.deepEqual(fixture.stdout, []);
  assert.deepEqual(
    summaryLines(fixture.dataDirectory).map((line) => [line.arm, line.hookMode, line.served]),
    [['shadow', 'shadow', 1]],
  );
  assert.deepEqual(
    fullDecisionLines(fixture.dataDirectory).map((line) => [path.basename(String(line.questionId)), line.served, line.arm]),
    [['NEVER_REPUBLISH.md', true, 'shadow']],
  );
  const servingFixture = { ...fixture.dependencies, loadConfig: async () => ({ ...(await fixture.dependencies.loadConfig()), hookMode: 'serve' as const }) };
  await runRecall(['--hook'], { ...servingFixture, readStdin: () => Promise.resolve(hookPayload(PULL_REQUEST_TASK, 'session-shadow')) });
  assert.match(fixture.stdout.join(''), /NEVER_REPUBLISH\.md/);
});

test('split mode records the arm it picked, and the same prompt always lands in the same arm', async () => {
  const fixture = hookFixture({ hookMode: 'split' });
  for (const sessionId of [...SPLIT_SESSIONS, ...SPLIT_SESSIONS]) {
    await fixture.promptHook(PULL_REQUEST_TASK, sessionId);
  }
  const summaries = summaryLines(fixture.dataDirectory);
  assert.equal(summaries.length, 40);
  assert.ok(summaries.every((line) => line.hookMode === 'split'));
  const armsBySession = new Map<unknown, Set<unknown>>();
  for (const line of summaries) {
    armsBySession.set(line.sessionId, (armsBySession.get(line.sessionId) ?? new Set()).add(line.arm));
  }
  assert.ok([...armsBySession.values()].every((arms) => arms.size === 1));
  const firstRoundArms = summaries.slice(0, 20).map((line) => line.arm);
  assert.deepEqual(new Set(firstRoundArms), new Set(['serve', 'shadow']));
  const printedMemories = fixture.stdout.filter((text) => text.includes('NEVER_REPUBLISH.md')).length;
  assert.equal(printedMemories, firstRoundArms.filter((arm) => arm === 'serve').length);
});

test('every ledger line but a compact answer line carries the arm', async () => {
  const fixture = hookFixture({ hookMode: 'split' });
  for (const sessionId of SPLIT_SESSIONS) {
    await fixture.promptHook(PULL_REQUEST_TASK, sessionId);
  }
  await runRecall([...IN_PROJECT, PULL_REQUEST_TASK], fixture.dependencies);
  const lines = ledgerLines(fixture.dataDirectory).filter((line) => !isCompactAnswerLine(line));
  assert.ok(lines.length > SPLIT_SESSIONS.length);
  assert.deepEqual(
    lines.filter((line) => !['serve', 'shadow'].includes(String(line.arm)) || !('sessionId' in line)),
    [],
  );
  assert.deepEqual(lines.at(-1)?.arm, 'serve');
  assert.deepEqual(summaryLines(fixture.dataDirectory).at(-1)?.source, 'command');
});

test("every prompt's ledger summary records Jev's verdict and its confidence", async () => {
  const fixture = hookFixture({}, { backend: sureNoBackend(0.8) });
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-unsure');
  const withoutMemories = hookFixture({});
  await runRecall(['--hook'], {
    ...withoutMemories.dependencies,
    loadConfig: async () => ({ ...(await withoutMemories.dependencies.loadConfig()), globalMemoryDirectories: [] }),
    resolveProjectMemoryDirectory: () => Promise.resolve(undefined),
    readStdin: () => Promise.resolve(hookPayload(PULL_REQUEST_TASK, 'session-empty')),
  });
  const servingFixture = hookFixture({});
  await servingFixture.promptHook(PULL_REQUEST_TASK, 'session-sure');
  const verdictsOf = (dataDirectory: string) =>
    summaryLines(dataDirectory).map((line) => [line.verdict, Number(line.verdictConfidence).toFixed(2), line.questionsAsked]);
  assert.deepEqual(verdictsOf(fixture.dataDirectory), [['no relevant memory', '0.80', 2]]);
  assert.deepEqual(verdictsOf(withoutMemories.dataDirectory), [['no relevant memory', '1.00', 0]]);
  assert.deepEqual(verdictsOf(servingFixture.dataDirectory), [['memory likely exists', '1.00', 2]]);
});

test('the serve arm shows the verdict line with the memories it serves', async () => {
  const fixture = hookFixture({ hookMode: 'serve' });
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-serve');
  assert.match(
    fixture.stdout.join(''),
    /^Recalled memories[\s\S]*## NEVER_REPUBLISH\.md[\s\S]*\n\nrules: a relevant memory likely exists in project's memories and the global memories\.\nSearched: [^\n]*\n[^\n]*throne recall --directory[^\n]*\n$/,
  );
});

test('when nothing is served the verdict line is shown alone only when Jev is surer than the configured threshold that nothing relevant exists', async () => {
  const surerThanThreshold = hookFixture({ verdictLineThreshold: 0.9 }, { backend: sureNoBackend(0.95) });
  await surerThanThreshold.promptHook(PULL_REQUEST_TASK, 'session-sure-nothing');
  assert.match(
    surerThanThreshold.stdout.join(''),
    /^Jev \(95% sure\): no relevant memory in project's memories and the global memories\.\nSearched: /,
  );

  const lessSureThanThreshold = hookFixture({ verdictLineThreshold: 0.97 }, { backend: sureNoBackend(0.95) });
  await lessSureThanThreshold.promptHook(PULL_REQUEST_TASK, 'session-unsure-nothing');
  assert.deepEqual(lessSureThanThreshold.stdout, ['']);

  const relevantButTooLarge = hookFixture({ verdictLineThreshold: 0, maximumInjectedCharacters: 150 });
  await relevantButTooLarge.promptHook(PULL_REQUEST_TASK, 'session-too-large');
  assert.deepEqual(relevantButTooLarge.stdout, ['']);
});

test('a repeat prompt whose relevant memory was already served in the session is told a relevant memory exists, and nothing is served twice', async () => {
  const fixture = hookFixture({ hookMode: 'serve', verdictLineThreshold: 0 });
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-repeat');
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-repeat');
  assert.match(fixture.stdout[0] ?? '', /## NEVER_REPUBLISH\.md[\s\S]*rules: a relevant memory likely exists in [^\n]*\nSearched: [^\n]*\n[^\n]*\n$/);
  assert.equal(fixture.stdout[1], '');
  assert.deepEqual(fixture.stderr, []);
  assert.deepEqual(
    summaryLines(fixture.dataDirectory).map((line) => [line.verdict, line.verdictConfidence, line.served]),
    [
      ['memory likely exists', 1, 1],
      ['memory likely exists', 1, 0],
    ],
  );
});

test('a typed prompt is recorded with whether it corrects an agent, and other kinds are not asked', async () => {
  const questionIdsPerCall: string[][] = [];
  const fixture = hookFixture(
    { hookMode: 'serve' },
    {
      backend: {
        name: RULES_BACKEND.name,
        answer: (state, questions) => {
          questionIdsPerCall.push(questions.map((question) => question.id));
          return RULES_BACKEND.answer(state, questions);
        },
      },
    },
  );
  const correcting = `that's wrong, you should have kept the pull request description`;
  for (const prompt of [correcting, PULL_REQUEST_TASK, DIRECT_RELAY, TASK_NOTIFICATION]) {
    await fixture.promptHook(prompt, 'session-correction');
  }
  assert.deepEqual(
    promptLogLines(fixture.dataDirectory).map((line) => [line.promptKind, line.correction]),
    [
      ['typed', { pick: 'yes', probability: 1, backend: 'rules', failedOpen: false }],
      ['typed', NOT_A_CORRECTION_BY_RULES],
      ['relayed', undefined],
      ['task-notification', undefined],
    ],
  );
  assert.equal(questionIdsPerCall.length, 4);
  assert.deepEqual(
    questionIdsPerCall.map((questionIds) => questionIds.includes(CORRECTION_QUESTION_ID)),
    [true, true, false, false],
  );
});

test('a prompt whose judging fails is still written to the prompt log', async () => {
  const fixture = hookFixture({ hookMode: 'serve' });
  await runRecall(['--hook'], {
    ...fixture.dependencies,
    readStdin: () => Promise.resolve(hookPayload(PULL_REQUEST_TASK, 'session-failing')),
    chooseBackend: () => Promise.reject(new Error('no backend today')),
  });
  assert.deepEqual(
    promptLogLines(fixture.dataDirectory).map((line) => [line.sessionId, line.promptKind, 'correction' in line]),
    [['session-failing', 'typed', false]],
  );
});

test("a memory withheld because it was already shown is recorded as suppressed with the earlier prompt's time", async () => {
  const fixture = hookFixture({ hookMode: 'serve' });
  const promptAt = (at: string, sessionId: string) =>
    runRecall(['--hook'], {
      ...fixture.dependencies,
      readStdin: () => Promise.resolve(hookPayload(PULL_REQUEST_TASK, sessionId)),
      now: () => new Date(at),
    });
  await promptAt('2026-09-21T01:00:00Z', 'session-suppressed');
  await promptAt('2026-09-21T02:00:00Z', 'session-suppressed');
  mkdirSync(path.join(fixture.dataDirectory, 'served'), { recursive: true });
  writeFileSync(
    path.join(fixture.dataDirectory, 'served', 'session-old-list.json'),
    JSON.stringify([realpathSync(path.join(fixture.projectMemories, 'NEVER_REPUBLISH.md'))]),
  );
  await promptAt('2026-09-21T03:00:00Z', 'session-old-list');
  const neverRepublishLines = decisionLines(fixture.dataDirectory).filter((line) =>
    String(line.questionId).endsWith('NEVER_REPUBLISH.md'),
  );
  assert.deepEqual(
    neverRepublishLines.map((line) => [line.at, line.served, line.suppressed, line.servedEarlierAt]),
    [
      ['2026-09-21T01:00:00.000Z', true, undefined, undefined],
      ['2026-09-21T02:00:00.000Z', false, true, '2026-09-21T01:00:00.000Z'],
      ['2026-09-21T03:00:00.000Z', false, true, null],
    ],
  );
});

test('every ledger candidate carries the content hash of the text it was judged on and that version is kept', async () => {
  const fixture = hookFixture({ hookMode: 'serve' });
  const memoryPath = path.join(fixture.projectMemories, 'NEVER_REPUBLISH.md');
  const firstText = readFileSync(memoryPath, 'utf8');
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-version-one');
  const secondText = `${firstText}\n- and never edit it in the browser\n`;
  writeFileSync(memoryPath, secondText);
  await fixture.promptHook(PULL_REQUEST_TASK, 'session-version-two');
  assert.deepEqual(
    decisionLines(fixture.dataDirectory).map((line) => [line.sessionId, line.questionId, line.contentHash]),
    [
      ['session-version-one', realpathSync(memoryPath), contentHashOf(firstText)],
      ['session-version-two', realpathSync(memoryPath), contentHashOf(secondText)],
    ],
  );
  const versionsDirectory = path.join(fixture.dataDirectory, MEMORY_VERSIONS_DIRECTORY_NAME);
  assert.deepEqual(readdirSync(versionsDirectory).sort(), [contentHashOf(firstText), contentHashOf(secondText)].sort());
  for (const text of [firstText, secondText]) {
    assert.equal(readFileSync(path.join(versionsDirectory, contentHashOf(text)), 'utf8'), text);
  }
});

test("the prompt log records the session's transcript path", async () => {
  const fixture = hookFixture({});
  await runRecall(['--hook'], {
    ...fixture.dependencies,
    readStdin: () =>
      Promise.resolve(hookPayload(PULL_REQUEST_TASK, 'session-transcript', '/transcripts/session-transcript.jsonl')),
  });
  assert.deepEqual(
    promptLogLines(fixture.dataDirectory).map((line) => line.transcriptPath),
    ['/transcripts/session-transcript.jsonl'],
  );
});
