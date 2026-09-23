import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO,
  YES,
  YES_OR_NO_CHOICES,
  type BackendAnswer,
  type ClassifierBackend,
  type FailOpenQuestion,
} from './classifier.types.ts';
import { askFailingOpen } from './fail-open-classifier.ts';

function keepQuestion(id: string): FailOpenQuestion {
  return {
    id,
    instructions: 'Is this relevant?',
    choices: YES_OR_NO_CHOICES,
    yesOrNoRule: { kind: 'any-phrase', phrases: [] },
    safePick: YES,
    minimumProbabilityOfSafePick: 0.5,
  };
}

function backendAnswering(
  answer: (questions: readonly FailOpenQuestion[]) => Promise<readonly BackendAnswer[]>,
): ClassifierBackend & { callCount: number } {
  const backend = {
    name: 'jev' as const,
    callCount: 0,
    answer: (_state: string, questions: readonly FailOpenQuestion[]) => {
      backend.callCount += 1;
      return answer(questions);
    },
  };
  return backend as ClassifierBackend & { callCount: number };
}

function collectingStderr(): { lines: string[]; writeStderr(text: string): void } {
  const lines: string[] = [];
  return { lines, writeStderr: (text) => lines.push(text) };
}

class RateLimitedError extends Error {
  readonly status = 429;
  override readonly name = 'RateLimitError';
}

class TimedOutError extends Error {
  override readonly name = 'APITimeoutError';
}

const FAILURES: readonly [string, () => Error, RegExp][] = [
  ['throws', () => new Error('boom with secret-looking detail'), /Error/],
  ['times out', () => new TimedOutError('timed out'), /APITimeoutError/],
  ['is rate limited with HTTP 429', () => new RateLimitedError('slow down'), /HTTP 429/],
];

for (const [situation, makeError, expectedStderr] of FAILURES) {
  test(`a backend that ${situation} gives every question its safe answer and one stderr line`, async () => {
    const backend = backendAnswering(() => Promise.reject(makeError()));
    const stderr = collectingStderr();
    const answers = await askFailingOpen(
      backend,
      'state',
      [keepQuestion('a'), keepQuestion('b')],
      stderr,
    );
    assert.equal(backend.callCount, 1);
    assert.deepEqual(
      answers.map((answer) => [answer.questionId, answer.pick, answer.failedOpen, answer.backend]),
      [
        ['a', YES, true, 'jev'],
        ['b', YES, true, 'jev'],
      ],
    );
    assert.equal(stderr.lines.length, 1);
    assert.match(stderr.lines[0] ?? '', expectedStderr);
    assert.doesNotMatch(stderr.lines[0] ?? '', /secret-looking/);
  });
}

test('a confident pick away from the safe answer is honoured', async () => {
  const backend = backendAnswering((questions) =>
    Promise.resolve(questions.map((question) => ({ questionId: question.id, pick: NO, probability: 0.9 }))),
  );
  const stderr = collectingStderr();
  const answers = await askFailingOpen(backend, 'state', [keepQuestion('a')], stderr);
  assert.deepEqual(answers, [
    { questionId: 'a', pick: NO, probability: 0.9, backend: 'jev', failedOpen: false },
  ]);
  assert.deepEqual(stderr.lines, []);
});

test('an unsure pick away from the safe answer becomes the safe answer', async () => {
  const backend = backendAnswering((questions) =>
    Promise.resolve(questions.map((question) => ({ questionId: question.id, pick: NO, probability: 0.5 }))),
  );
  const answers = await askFailingOpen(backend, 'state', [keepQuestion('a')], collectingStderr());
  assert.equal(answers[0]?.pick, YES);
  assert.equal(answers[0]?.probability, 0.5);
  assert.equal(answers[0]?.failedOpen, false);
});

test('a lower minimum probability serves a memory the default threshold would drop', async () => {
  const backend = backendAnswering((questions) =>
    Promise.resolve(questions.map((question) => ({ questionId: question.id, pick: NO, probability: 0.65 }))),
  );
  const answers = await askFailingOpen(
    backend,
    'state',
    [keepQuestion('default'), { ...keepQuestion('high-cost'), minimumProbabilityOfSafePick: 0.3 }],
    collectingStderr(),
  );
  assert.deepEqual(
    answers.map((answer) => answer.pick),
    [NO, YES],
  );
});

test('a missing, unknown or out-of-range answer fails open for that question only', async () => {
  const backend = backendAnswering(() =>
    Promise.resolve([
      { questionId: 'unknown-pick', pick: 'maybe', probability: 0.9 },
      { questionId: 'out-of-range', pick: NO, probability: 7 },
      { questionId: 'fine', pick: NO, probability: 0.9 },
    ]),
  );
  const stderr = collectingStderr();
  const answers = await askFailingOpen(
    backend,
    'state',
    ['missing', 'unknown-pick', 'out-of-range', 'fine'].map(keepQuestion),
    stderr,
  );
  assert.deepEqual(
    answers.map((answer) => [answer.pick, answer.failedOpen]),
    [
      [YES, true],
      [YES, true],
      [YES, true],
      [NO, false],
    ],
  );
  assert.equal(stderr.lines.length, 1);
  assert.match(stderr.lines[0] ?? '', /3 of 4/);
});

test('no questions means the backend is never called', async () => {
  const backend = backendAnswering(() => Promise.resolve([]));
  assert.deepEqual(await askFailingOpen(backend, 'state', [], collectingStderr()), []);
  assert.equal(backend.callCount, 0);
});

test('a backend that never answers is abandoned at the timeout and fails open', async () => {
  const backend = backendAnswering(() => new Promise<never>(() => undefined));
  const stderr = collectingStderr();
  const answers = await askFailingOpen(backend, 'state', [keepQuestion('a')], stderr, {
    timeoutMilliseconds: 20,
  });
  assert.deepEqual(
    answers.map((answer) => [answer.pick, answer.failedOpen]),
    [[YES, true]],
  );
  assert.match(stderr.lines[0] ?? '', /ClassifierTimedOutError/);
});

test('when a second backend is named it answers in place of the failed first one', async () => {
  const failing = backendAnswering(() => Promise.reject(new RateLimitedError('slow down')));
  const second: ClassifierBackend = {
    name: 'rules',
    answer: (_state, questions) =>
      Promise.resolve(questions.map((question) => ({ questionId: question.id, pick: NO, probability: 1 }))),
  };
  const stderr = collectingStderr();
  const answers = await askFailingOpen(failing, 'state', [keepQuestion('a')], stderr, {
    backendWhenTheFirstFails: second,
  });
  assert.deepEqual(answers, [
    { questionId: 'a', pick: NO, probability: 1, backend: 'rules', failedOpen: true },
  ]);
  assert.equal(stderr.lines.length, 1);
  assert.match(stderr.lines[0] ?? '', /HTTP 429.*rules backend answers instead/);
});
