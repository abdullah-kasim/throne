import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import { PRODUCTION_JEV_DEPENDENCIES } from '../relevance-classifier/jev-backend.ts';
import type { BackendAnswer, ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { YES } from '../relevance-classifier/classifier.types.ts';
import { DEFAULT_RECALL_CONFIG, type RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { requestsPackedUnderTheStateLimit } from '../item-rank/rank-requests.ts';
import {
  judgeCandidates,
  judgeQuestionText,
  type Candidate,
  type JudgeDependencies,
} from './judge-candidates.ts';

const ALLOWED_ROOT = '/allowed/root';
const ALLOWED_PATH = '/allowed/root/inside.ts';
const DISALLOWED_PATH = '/elsewhere/other.ts';

function candidateAt(path: string): Candidate {
  return { path, reasons: [`matches:credentials`], score: 0.4 };
}

function fixedAnswerJevBackend(probability: number): ClassifierBackend {
  return {
    name: 'jev',
    answer: async (_state, questions) =>
      questions.map((question) => ({
        questionId: question.id,
        pick: YES,
        probability,
      })),
  };
}

function throwingJevBackend(): ClassifierBackend {
  return {
    name: 'jev',
    answer: async () => {
      throw new Error('jev unreachable in this test');
    },
  };
}

function fakeDependencies(
  chooseBackend: JudgeDependencies['chooseBackend'],
  fileTextByPath: Readonly<Record<string, string>>,
  physicalPathByPath: Readonly<Record<string, string>>,
  stderr: string[],
): JudgeDependencies {
  return {
    chooseBackend,
    readFile: async (path) => {
      const text = fileTextByPath[path];
      if (text === undefined) throw new Error(`no fixture text for ${path}`);
      return text;
    },
    realPathOrUndefined: async (path) => physicalPathByPath[path],
    writeStderr: (text) => {
      stderr.push(text);
    },
  };
}

const CONFIG_WITH_ALLOWED_ROOT: RecallConfig = {
  ...DEFAULT_RECALL_CONFIG,
  jevEnabled: true,
  rankAllowedRoots: [ALLOWED_ROOT],
};

async function rulesOnlyProbability(task: string, fileText: string): Promise<number> {
  const requests = requestsPackedUnderTheStateLimit(judgeQuestionText(task), [
    { id: 'oracle', text: fileText, mayBeSentToJev: false },
  ]);
  const answers = (
    await Promise.all(requests.map((request) => askFailingOpen(RULES_BACKEND, request.state, request.questions)))
  ).flat();
  const answer = answers[0] as BackendAnswer;
  return answer.probability;
}

test('judgeCandidates sends an allowed-root candidate to Jev and judges it with Jev\'s answer', async () => {
  const stderr: string[] = [];
  const dependencies = fakeDependencies(
    async () => fixedAnswerJevBackend(0.93),
    { [ALLOWED_PATH]: 'this file rotates signing credentials' },
    { [ALLOWED_ROOT]: ALLOWED_ROOT, [ALLOWED_PATH]: ALLOWED_PATH },
    stderr,
  );
  const [judged] = await judgeCandidates(
    [candidateAt(ALLOWED_PATH)],
    'rotate signing credentials',
    CONFIG_WITH_ALLOWED_ROOT,
    dependencies,
  );
  assert.equal(judged?.score, 0.93);
});

test('judgeCandidates judges a disallowed-root candidate with the rules backend and names it on stderr', async () => {
  const stderr: string[] = [];
  const task = 'rotate signing credentials';
  const fileText = 'this file rotates signing credentials';
  const dependencies = fakeDependencies(
    async () => fixedAnswerJevBackend(0.93),
    { [ALLOWED_PATH]: fileText, [DISALLOWED_PATH]: fileText },
    { [ALLOWED_ROOT]: ALLOWED_ROOT, [ALLOWED_PATH]: ALLOWED_PATH, [DISALLOWED_PATH]: DISALLOWED_PATH },
    stderr,
  );
  const expectedRulesProbability = await rulesOnlyProbability(task, fileText);
  const judged = await judgeCandidates(
    [candidateAt(ALLOWED_PATH), candidateAt(DISALLOWED_PATH)],
    task,
    CONFIG_WITH_ALLOWED_ROOT,
    dependencies,
  );
  const disallowed = judged.find((candidate) => candidate.path === DISALLOWED_PATH);
  assert.equal(disallowed?.score, expectedRulesProbability);
  assert.ok(stderr.some((line) => line.includes(DISALLOWED_PATH)));
});

test('judgeCandidates falls open to the rules backend when Jev fails', async () => {
  const stderr: string[] = [];
  const task = 'rotate signing credentials';
  const fileText = 'this file rotates signing credentials';
  const dependencies = fakeDependencies(
    async () => throwingJevBackend(),
    { [ALLOWED_PATH]: fileText },
    { [ALLOWED_ROOT]: ALLOWED_ROOT, [ALLOWED_PATH]: ALLOWED_PATH },
    stderr,
  );
  const expectedRulesProbability = await rulesOnlyProbability(task, fileText);
  const [judged] = await judgeCandidates(
    [candidateAt(ALLOWED_PATH)],
    task,
    CONFIG_WITH_ALLOWED_ROOT,
    dependencies,
  );
  assert.equal(judged?.score, expectedRulesProbability);
  assert.ok(stderr.some((line) => line.includes('jev')));
});

test('judgeCandidates uses the rules backend when THRONE_JEV_DISABLED overrides an enabled config', async () => {
  const stderr: string[] = [];
  const task = 'rotate signing credentials';
  const fileText = 'this file rotates signing credentials';
  const dependencies = fakeDependencies(
    (config) =>
      chooseClassifierBackend(config, {
        jevSwitch: {
          environment: { THRONE_JEV_DISABLED: '1' },
          readKeyFile: async () => 'unused-key-material',
        },
        jevBackend: PRODUCTION_JEV_DEPENDENCIES,
        writeStderr: () => undefined,
      }),
    { [ALLOWED_PATH]: fileText },
    { [ALLOWED_ROOT]: ALLOWED_ROOT, [ALLOWED_PATH]: ALLOWED_PATH },
    stderr,
  );
  const expectedRulesProbability = await rulesOnlyProbability(task, fileText);
  const [judged] = await judgeCandidates(
    [candidateAt(ALLOWED_PATH)],
    task,
    CONFIG_WITH_ALLOWED_ROOT,
    dependencies,
  );
  assert.equal(judged?.score, expectedRulesProbability);
});
