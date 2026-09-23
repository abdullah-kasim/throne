import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO,
  YES,
  yesOrNoQuestion,
  type ClassifierQuestion,
  type ClassifierState,
  type FailOpenQuestion,
} from './classifier.types.ts';
import { askFailingOpen } from './fail-open-classifier.ts';
import {
  JEV_REQUEST_TOKEN_LIMIT,
  JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT,
  createJevBackend,
  estimatedTokens,
  type JevBackendDependencies,
  type JevClient,
  type JevQuestion,
  type JevResponse,
} from './jev-backend.ts';

const FAKE_KEY = 'not-a-real-key';
const UNUSED_RULE = { kind: 'any-phrase', phrases: [] } as const;

interface RecordedRequest {
  readonly state: ClassifierState;
  readonly questions: Record<string, JevQuestion>;
}

function fakeJev(respond: (question: JevQuestion) => JevResponse): {
  dependencies: JevBackendDependencies;
  keyFileReads: string[];
  clientsCreatedWithKeys: string[];
  requests: RecordedRequest[];
} {
  const keyFileReads: string[] = [];
  const clientsCreatedWithKeys: string[] = [];
  const requests: RecordedRequest[] = [];
  const client: JevClient = {
    systemOne: (request) => {
      requests.push(request);
      return Promise.resolve({
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([name, question]) => [name, respond(question)]),
        ),
      });
    },
  };
  return {
    keyFileReads,
    clientsCreatedWithKeys,
    requests,
    dependencies: {
      readKeyFile: (keyFilePath) => {
        keyFileReads.push(keyFilePath);
        return Promise.resolve(`${FAKE_KEY}\n`);
      },
      createClient: (apiKey) => {
        clientsCreatedWithKeys.push(apiKey);
        return Promise.resolve(client);
      },
    },
  };
}

test('a yes or no question is asked as a noul and answered with the likelier side', async () => {
  const jev = fakeJev((question) => ({
    type: 'noul',
    noul: question.instructions.includes('billing') ? 0.9 : 0.2,
  }));
  const answers = await createJevBackend('/keys/jev', jev.dependencies).answer('the task text', [
    yesOrNoQuestion('memory/one', 'Is this about billing?', UNUSED_RULE),
    yesOrNoQuestion('memory/two', 'Is this about wifi?', UNUSED_RULE),
  ]);
  assert.deepEqual(answers, [
    { questionId: 'memory/one', pick: YES, probability: 0.9 },
    { questionId: 'memory/two', pick: NO, probability: 0.8 },
  ]);
  assert.equal(jev.requests.length, 1);
  assert.equal(jev.requests[0]?.state, 'the task text');
  assert.deepEqual(Object.values(jev.requests[0]?.questions ?? {}), [
    { type: 'noul', instructions: 'Is this about billing?' },
    { type: 'noul', instructions: 'Is this about wifi?' },
  ]);
});

test('a question with named choices is asked as a choice', async () => {
  const jev = fakeJev(() => ({
    type: 'choice',
    choice: 'blocked',
    probabilities: { working: 0.1, blocked: 0.7, finished: 0.2 },
  }));
  const question: ClassifierQuestion = {
    id: 'status',
    instructions: 'What state is it in?',
    choices: ['working', 'blocked', 'finished'],
    yesOrNoRule: UNUSED_RULE,
  };
  const answers = await createJevBackend('/keys/jev', jev.dependencies).answer('state', [question]);
  assert.deepEqual(answers, [{ questionId: 'status', pick: 'blocked', probability: 0.7 }]);
  assert.deepEqual(Object.values(jev.requests[0]?.questions ?? {}), [
    {
      type: 'choice',
      instructions: 'What state is it in?',
      criteria: { working: null, blocked: null, finished: null },
    },
  ]);
});

test('more questions than one request may hold are split across requests, none lost', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 1 }));
  const longInstructions = 'Does the task involve this very particular situation? '.repeat(40);
  const questions = Array.from({ length: 200 }, (_unused, index) =>
    yesOrNoQuestion(`memory-${index}`, longInstructions, UNUSED_RULE),
  );
  const answers = await createJevBackend('/keys/jev', jev.dependencies).answer('short task', questions);
  assert.equal(answers.length, 200);
  assert.ok(jev.requests.length > 1);
  for (const request of jev.requests) {
    const requestTokens =
      estimatedTokens(String(request.state)) +
      Object.values(request.questions).reduce(
        (total, question) => total + estimatedTokens(question.instructions),
        0,
      );
    assert.ok(requestTokens <= JEV_REQUEST_TOKEN_LIMIT);
  }
});

test('an over-long state is cut to fit beside the longest question', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 1 }));
  const question = yesOrNoQuestion('a', 'Is it relevant?', UNUSED_RULE);
  await createJevBackend('/keys/jev', jev.dependencies).answer('x'.repeat(500_000), [question]);
  const sentState = String(jev.requests[0]?.state ?? '');
  assert.ok(sentState.length > 0);
  assert.ok(
    estimatedTokens(sentState) + estimatedTokens(question.instructions) <=
      JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT,
  );
});

test('a missing key file fails open without the path or any key text reaching stderr', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 0 }));
  const backend = createJevBackend('/keys/jev', {
    ...jev.dependencies,
    readKeyFile: () => Promise.reject(new Error('ENOENT: no such file /keys/jev')),
  });
  const stderrLines: string[] = [];
  const question: FailOpenQuestion = {
    ...yesOrNoQuestion('a', 'Is it?', UNUSED_RULE),
    safePick: YES,
    minimumProbabilityOfSafePick: 0.5,
  };
  const answers = await askFailingOpen(backend, 'state', [question], {
    writeStderr: (text) => stderrLines.push(text),
  });
  assert.deepEqual(
    answers.map((answer) => [answer.pick, answer.failedOpen]),
    [[YES, true]],
  );
  assert.deepEqual(jev.clientsCreatedWithKeys, []);
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0] ?? '', /JevKeyUnavailableError/);
  assert.doesNotMatch(stderrLines[0] ?? '', /\/keys\/jev|ENOENT/);
});

test('a client error that quotes the key never reaches stderr, and neither does the key file path', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 0 }));
  const backend = createJevBackend('/keys/jev', {
    ...jev.dependencies,
    createClient: () =>
      Promise.resolve({
        systemOne: () => Promise.reject(new Error(`401 for key ${FAKE_KEY} read from /keys/jev`)),
      }),
  });
  const stderrLines: string[] = [];
  const question: FailOpenQuestion = {
    ...yesOrNoQuestion('a', 'Is it?', UNUSED_RULE),
    safePick: YES,
    minimumProbabilityOfSafePick: 0.5,
  };
  await askFailingOpen(backend, 'state', [question], { writeStderr: (text) => stderrLines.push(text) });
  assert.equal(stderrLines.length, 1);
  assert.doesNotMatch(stderrLines.join(''), new RegExp(FAKE_KEY));
  assert.doesNotMatch(stderrLines.join(''), /\/keys\/jev/);
});

test('an abandoned question hands the client a signal that is aborted at the timeout', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 0 }));
  let receivedSignal: AbortSignal | undefined;
  const backend = createJevBackend('/keys/jev', {
    ...jev.dependencies,
    createClient: () =>
      Promise.resolve({
        systemOne: (_request, options) => {
          receivedSignal = options?.signal;
          return new Promise<never>(() => undefined);
        },
      }),
  });
  const question: FailOpenQuestion = {
    ...yesOrNoQuestion('a', 'Is it?', UNUSED_RULE),
    safePick: YES,
    minimumProbabilityOfSafePick: 0.5,
  };
  await askFailingOpen(backend, 'state', [question], { writeStderr: () => undefined }, { timeoutMilliseconds: 20 });
  assert.equal(receivedSignal?.aborted, true);
});

test('the key file is read once for many calls to one backend', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 1 }));
  const backend = createJevBackend('/keys/jev', jev.dependencies);
  await backend.answer('chunk one', [yesOrNoQuestion('a', 'Is it?', UNUSED_RULE)]);
  await backend.answer('chunk two', [yesOrNoQuestion('b', 'Is it?', UNUSED_RULE)]);
  assert.deepEqual(jev.keyFileReads, ['/keys/jev']);
  assert.equal(jev.requests.length, 2);
});

test('named state fields are sent as an object and an over-long field is cut to fit', async () => {
  const jev = fakeJev(() => ({ type: 'noul', noul: 1 }));
  const question = yesOrNoQuestion('a', 'Is `task` about billing?', UNUSED_RULE, 'task');
  await createJevBackend('/keys/jev', jev.dependencies).answer(
    { task: 'x'.repeat(500_000), repository: 'project' },
    [question],
  );
  const sentState = jev.requests[0]?.state as Record<string, string>;
  assert.equal(sentState.repository, 'project');
  assert.ok((sentState.task ?? '').length > 0);
  assert.ok(
    estimatedTokens(JSON.stringify(sentState)) + estimatedTokens(question.instructions) <=
      JEV_STATE_AND_LONGEST_QUESTION_TOKEN_LIMIT,
  );
});
