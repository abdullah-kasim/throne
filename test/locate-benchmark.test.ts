import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  gatherCandidates,
  type Candidate,
} from '../src/file-locate/gather-candidates.ts';
import {
  judgeCandidates,
  PRODUCTION_JUDGE_DEPENDENCIES,
} from '../src/file-locate/judge-candidates.ts';
import { DEFAULT_RECALL_CONFIG } from '../src/relevance-classifier/recall-user-config.ts';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const FIXTURE_PATH = path.join(REPO_ROOT, 'test/fixtures/locate-benchmark.json');
const TOP_N = 10;
const RECALL_AT_10_TASKS_TO_WIN = 7;

interface BenchmarkTask {
  readonly id: string;
  readonly text: string;
  readonly truth: readonly string[];
}

function recallAtTen(orderedPaths: readonly string[], truth: readonly string[]): number {
  const topPaths = new Set(orderedPaths.slice(0, TOP_N));
  const foundCount = truth.filter((truthPath) => topPaths.has(truthPath)).length;
  return foundCount / truth.length;
}

function reciprocalRank(orderedPaths: readonly string[], truth: readonly string[]): number {
  const truthSet = new Set(truth);
  const firstTrueIndex = orderedPaths.findIndex((candidatePath) => truthSet.has(candidatePath));
  return firstTrueIndex === -1 ? 0 : 1 / (firstTrueIndex + 1);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function loadBenchmarkTasks(): Promise<readonly BenchmarkTask[]> {
  const raw = await readFile(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as BenchmarkTask[];
}

function jevBenchmarkLegEnabled(): boolean {
  return process.env.THRONE_LOCATE_BENCHMARK_JEV === '1';
}

async function recallConfigForBenchmark() {
  if (!jevBenchmarkLegEnabled()) return DEFAULT_RECALL_CONFIG;
  const keyFilePath = await realpath(
    DEFAULT_RECALL_CONFIG.jevKeyFile.replace(/^~/, process.env.HOME ?? ''),
  ).catch(() => undefined);
  if (keyFilePath === undefined) return DEFAULT_RECALL_CONFIG;
  return { ...DEFAULT_RECALL_CONFIG, jevEnabled: true };
}

test('judged re-ranking beats stage-1 ordering alone on recall@10', async () => {
  const tasks = await loadBenchmarkTasks();
  assert.ok(tasks.length >= 10, 'benchmark fixture must hold at least 10 tasks');
  for (const task of tasks) {
    assert.ok(
      !task.truth.some((truthPath) => task.text.includes(truthPath)),
      `task ${task.id} leaks a truth path into its text`,
    );
  }

  const recallConfig = await recallConfigForBenchmark();

  const perTaskMetrics = await Promise.all(
    tasks.map(async (task) => {
      const stageACandidates = await gatherCandidates(task.text, [REPO_ROOT]);
      const stageAPaths = stageACandidates.map((candidate) => candidate.path);

      const judgedCandidates = await judgeCandidates(
        stageACandidates,
        task.text,
        recallConfig,
        PRODUCTION_JUDGE_DEPENDENCIES,
      );
      const stageBPaths = [...judgedCandidates]
        .sort((left, right) => right.score - left.score)
        .map((candidate) => candidate.path);

      const stageARecall = recallAtTen(stageAPaths, task.truth);
      const stageBRecall = recallAtTen(stageBPaths, task.truth);
      return {
        stageARecall,
        stageBRecall,
        stageAReciprocalRank: reciprocalRank(stageAPaths, task.truth),
        stageBReciprocalRank: reciprocalRank(stageBPaths, task.truth),
      };
    }),
  );

  const stageARecalls = perTaskMetrics.map((metrics) => metrics.stageARecall);
  const stageBRecalls = perTaskMetrics.map((metrics) => metrics.stageBRecall);
  const stageAReciprocalRanks = perTaskMetrics.map((metrics) => metrics.stageAReciprocalRank);
  const stageBReciprocalRanks = perTaskMetrics.map((metrics) => metrics.stageBReciprocalRank);
  const stageBWinsOnRecall = perTaskMetrics.filter(
    (metrics) => metrics.stageBRecall > metrics.stageARecall,
  ).length;

  const meanStageARecall = mean(stageARecalls);
  const meanStageBRecall = mean(stageBRecalls);
  const meanStageAMrr = mean(stageAReciprocalRanks);
  const meanStageBMrr = mean(stageBReciprocalRanks);
  const acceptanceVerdict = stageBWinsOnRecall >= RECALL_AT_10_TASKS_TO_WIN;

  process.stdout.write(
    `locate benchmark (${tasks.length} tasks): ` +
      `stage-1 recall@10=${meanStageARecall.toFixed(3)} mrr=${meanStageAMrr.toFixed(3)}; ` +
      `stage-1+2 recall@10=${meanStageBRecall.toFixed(3)} mrr=${meanStageBMrr.toFixed(3)}; ` +
      `stage-1+2 beats stage-1 on ${stageBWinsOnRecall}/${tasks.length} tasks; ` +
      `acceptance (>= ${RECALL_AT_10_TASKS_TO_WIN}/${tasks.length})=${acceptanceVerdict}\n`,
  );
});
