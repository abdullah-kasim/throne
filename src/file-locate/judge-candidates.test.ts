import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import type { BackendAnswer } from '../relevance-classifier/classifier.types.ts';
import { DEFAULT_RECALL_CONFIG } from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import { requestsPackedUnderTheStateLimit } from '../item-rank/rank-requests.ts';
import {
  judgeCandidates,
  judgeQuestionText,
  type Candidate,
  type JudgeDependencies,
} from './judge-candidates.ts';

const FIRST_PATH = '/project/inside.ts';
const SECOND_PATH = '/elsewhere/other.ts';

function candidateAt(path: string): Candidate {
  return { path, reasons: [`matches:credentials`], score: 0.4 };
}

function fakeDependencies(
  chooseBackend: JudgeDependencies['chooseBackend'],
  fileTextByPath: Readonly<Record<string, string>>,
  stderr: string[],
): JudgeDependencies {
  return {
    chooseBackend,
    readFile: async (path) => {
      const text = fileTextByPath[path];
      if (text === undefined) throw new Error(`no fixture text for ${path}`);
      return text;
    },
    writeStderr: (text) => {
      stderr.push(text);
    },
  };
}

async function rulesOnlyProbability(task: string, fileText: string): Promise<number> {
  const requests = requestsPackedUnderTheStateLimit(judgeQuestionText(task), [
    { id: 'oracle', text: fileText },
  ]);
  const answers = (
    await Promise.all(requests.map((request) => askFailingOpen(RULES_BACKEND, request.state, request.questions)))
  ).flat();
  const answer = answers[0] as BackendAnswer;
  return answer.probability;
}

test('judgeCandidates judges every candidate with the rules backend', async () => {
  const stderr: string[] = [];
  const task = 'rotate signing credentials';
  const fileText = 'this file rotates signing credentials';
  const dependencies = fakeDependencies(
    () => chooseClassifierBackend(),
    { [FIRST_PATH]: fileText, [SECOND_PATH]: fileText },
    stderr,
  );
  const expectedRulesProbability = await rulesOnlyProbability(task, fileText);
  const judged = await judgeCandidates(
    [candidateAt(FIRST_PATH), candidateAt(SECOND_PATH)],
    task,
    DEFAULT_RECALL_CONFIG,
    dependencies,
  );
  assert.deepEqual(
    judged.map((candidate) => candidate.score),
    [expectedRulesProbability, expectedRulesProbability],
  );
  assert.deepEqual(stderr, []);
});
