import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { makeScratchDirectory } from '../scratch-directory.test-support.ts';
import { judgeCandidates } from '../file-locate/judge-candidates.ts';
import { rankItemsByQuestion } from '../item-rank/rank-by-question.ts';
import { overlappingChunks } from '../log-sift/chunks.ts';
import { runSift } from '../log-sift/sift.command.ts';
import { chooseClassifierBackend } from './choose-backend.ts';
import {
  CLASSIFIER_RATE_LIMITED,
  YES,
  type ClassifierBackend,
  type FailOpenQuestion,
} from './classifier.types.ts';
import { askFailingOpen } from './fail-open-classifier.ts';
import { createJevBackend, type JevBackendDependencies, type JevClient } from './jev-backend.ts';
import { jevBudgetLockPath, readJevSpend, type JevLimits } from './jev-budget.ts';
import { SPENDING_QUESTION, SPENDING_STATE } from './jev-budget-processes.test-support.ts';
import { readJevUsageLines, type JevCallerKind } from './jev-usage-log.ts';
import { DEFAULT_RECALL_CONFIG } from './recall-user-config.ts';

const ROOMY_LIMITS: JevLimits = { tokensPerDay: 1_000_000, tokensPerHour: 1_000_000 };
const USED_UP_LIMITS: JevLimits = { tokensPerDay: 1, tokensPerHour: 1_000_000 };
const CHUNKS_SIFT_ASKS_AT_ONCE = 8;
const REPORTED_USAGE = { input_tokens: 40, output_tokens: 2 };

function scratchDataHome(): Promise<string> {
  return makeScratchDirectory('jev-backend-budget-');
}

interface FakeJev {
  readonly dependencies: JevBackendDependencies;
  readonly calls: number[];
}

function fakeJev(
  duringTheCall: () => Promise<void> = () => Promise.resolve(),
  usage?: typeof REPORTED_USAGE,
): FakeJev {
  const calls: number[] = [];
  const client: JevClient = {
    systemOne: async (request) => {
      calls.push(calls.length);
      await duringTheCall();
      return {
        answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: 1 }])),
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
  return {
    calls,
    dependencies: {
      readKeyFile: () => Promise.resolve('not-a-real-key'),
      createClient: () => Promise.resolve(client),
    },
  };
}

function budgetedJev(dataHome: string, limits: JevLimits, caller: JevCallerKind, jev: FakeJev): ClassifierBackend {
  return createJevBackend('/keys/jev', { dataHome, limits, caller }, jev.dependencies);
}

function failOpen(question = SPENDING_QUESTION): FailOpenQuestion {
  return { ...question, safePick: YES, minimumProbabilityOfSafePick: 1 };
}

test('a Jev request reserves the backend\'s own estimate before the call and records the reported usage after it', async () => {
  const dataHome = await scratchDataHome();
  let spentDuringTheCall = -1;
  const jev = fakeJev(async () => {
    spentDuringTheCall = (await readJevSpend(dataHome, new Date())).todayTokens;
  }, REPORTED_USAGE);
  await budgetedJev(dataHome, ROOMY_LIMITS, 'hand recall', jev).answer(SPENDING_STATE, [SPENDING_QUESTION]);
  const [line] = (await readJevUsageLines(dataHome)).lines;
  assert.ok(line !== undefined && line.estimatedTokens > 0);
  assert.equal(spentDuringTheCall, line.estimatedTokens);
  const realTokens = REPORTED_USAGE.input_tokens + REPORTED_USAGE.output_tokens;
  assert.equal(line.realTokens, realTokens);
  assert.deepEqual(await readJevSpend(dataHome, new Date()), { todayTokens: realTokens, lastHourTokens: realTokens });
});

test('the budget lock is not held while a Jev request is in flight', async () => {
  const dataHome = await scratchDataHome();
  let lockHeldDuringTheCall: boolean | undefined;
  const jev = fakeJev(async () => {
    lockHeldDuringTheCall = await access(jevBudgetLockPath(dataHome)).then(
      () => true,
      () => false,
    );
  });
  await budgetedJev(dataHome, ROOMY_LIMITS, 'hand recall', jev).answer(SPENDING_STATE, [SPENDING_QUESTION]);
  assert.equal(lockHeldDuringTheCall, false);
});

test('a request over the Jev budget is answered by the rules and Jev is never called', async () => {
  const dataHome = await scratchDataHome();
  const jev = fakeJev();
  const [answer] = await askFailingOpen(
    budgetedJev(dataHome, USED_UP_LIMITS, 'hand recall', jev),
    SPENDING_STATE,
    [failOpen()],
    { writeStderr: () => undefined },
  );
  assert.equal(jev.calls.length, 0);
  assert.deepEqual(
    { backend: answer?.backend, failedOpen: answer?.failedOpen, failure: answer?.failure },
    { backend: 'rules', failedOpen: true, failure: CLASSIFIER_RATE_LIMITED },
  );
  assert.deepEqual(
    (await readJevUsageLines(dataHome)).lines.map((line) => [line.outcome, line.realTokens]),
    [['rate-limited', null]],
  );
});

test('the Jev key is not read when the budget refuses the request', async () => {
  const dataHome = await scratchDataHome();
  const keyFileReads: string[] = [];
  const jev = fakeJev();
  const backend = createJevBackend(
    '/keys/jev',
    { dataHome, limits: USED_UP_LIMITS, caller: 'hand recall' },
    {
      ...jev.dependencies,
      readKeyFile: (keyFilePath) => {
        keyFileReads.push(keyFilePath);
        return Promise.resolve('not-a-real-key');
      },
    },
  );
  await assert.rejects(backend.answer(SPENDING_STATE, [SPENDING_QUESTION]), { name: 'JevBudgetUsedUpError' });
  assert.deepEqual(keyFileReads, []);
  await budgetedJev(dataHome, ROOMY_LIMITS, 'hand recall', jev).answer(SPENDING_STATE, [SPENDING_QUESTION]);
  assert.equal(jev.calls.length, 1);
});

test('every Jev request appends one usage line naming its caller', async () => {
  const dataHome = await scratchDataHome();
  const jev = fakeJev();
  const config = { ...DEFAULT_RECALL_CONFIG, jevEnabled: true, jevTokensPerDay: 50 };
  for (const caller of ['hook', 'rank', 'audit'] as const) {
    const backend = await chooseClassifierBackend(config, caller, {
      jevSwitch: { environment: {}, statKeyFile: () => Promise.resolve({ isFile: () => true, size: 14 }) },
      jevBackend: jev.dependencies,
      jevDataHome: dataHome,
      writeStderr: () => undefined,
    });
    await backend.answer(SPENDING_STATE, [SPENDING_QUESTION]).catch(() => undefined);
  }
  assert.deepEqual(
    (await readJevUsageLines(dataHome)).lines.map((line) => [line.caller, line.outcome]),
    [
      ['hook', 'answered'],
      ['rank', 'answered'],
      ['audit', 'rate-limited'],
    ],
  );
});

test('rank, sift and locate get rules answers when the Jev budget is used up', async () => {
  const dataHome = await scratchDataHome();
  const jev = fakeJev();

  const ranking = await rankItemsByQuestion(
    budgetedJev(dataHome, USED_UP_LIMITS, 'rank', jev),
    'Is this about billing invoices?',
    [
      { id: 'billing', text: 'billing invoices are retried nightly', mayBeSentToJev: true },
      { id: 'wifi', text: 'router channel settings', mayBeSentToJev: true },
    ],
  );
  assert.equal(ranking.failed, false);
  assert.deepEqual(
    ranking.ranked.map((item) => item.backend),
    ['rules', 'rules'],
  );
  assert.ok((ranking.ranked[0]?.probability ?? 0) > (ranking.ranked[1]?.probability ?? 1));

  const logLines = Array.from({ length: 600 }, (_unused, index) =>
    index === 400 ? 'error: billing invoice export failed' : `ok ${index} routine check`,
  );
  const sifted: string[] = [];
  await runSift(['billing', 'invoice'], {
    loadConfig: () => Promise.resolve(DEFAULT_RECALL_CONFIG),
    chooseBackend: () => Promise.resolve(budgetedJev(dataHome, USED_UP_LIMITS, 'sift', jev)),
    readJevSwitch: () => Promise.reject(new Error('not asked')),
    readJevSpending: () => Promise.reject(new Error('not asked')),
    readStdin: () => Promise.resolve(`${logLines.join('\n')}\n`),
    saveFullInput: () => Promise.resolve('/unused/full-copy.log'),
    writeStdout: (text) => sifted.push(text),
    writeStderr: () => undefined,
  });
  assert.match(sifted.join(''), /billing invoice export failed/);
  assert.doesNotMatch(sifted.join(''), /ok 60 routine check/);
  assert.doesNotMatch(sifted.join(''), /ok 500 routine check/);

  const [judged] = await judgeCandidates(
    [{ path: '/allowed/billing.ts', reasons: ['matches:billing'], score: 0.4 }],
    'retry billing invoices',
    { ...DEFAULT_RECALL_CONFIG, rankAllowedRoots: ['/allowed'] },
    {
      chooseBackend: () => Promise.resolve(budgetedJev(dataHome, USED_UP_LIMITS, 'locate', jev)),
      readFile: () => Promise.resolve('billing invoices are retried here'),
      realPathOrUndefined: (filePath) => Promise.resolve(filePath),
      writeStderr: () => undefined,
    },
  );
  assert.ok((judged?.score ?? 0) > 0);

  assert.equal(jev.calls.length, 0);
  const refusedCallers = new Set((await readJevUsageLines(dataHome)).lines.map((line) => `${line.caller} ${line.outcome}`));
  assert.deepEqual([...refusedCallers].sort(), ['locate rate-limited', 'rank rate-limited', 'sift rate-limited']);
  assert.ok(overlappingChunks(logLines).length > 2 * CHUNKS_SIFT_ASKS_AT_ONCE);
});
