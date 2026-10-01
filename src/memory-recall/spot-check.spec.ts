import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { NO, YES } from '../relevance-classifier/classifier.types.ts';
import { SERVE_ARM, SHADOW_ARM } from '../relevance-classifier/recall-user-config.ts';
import { GRADES_FILE_NAME, RELEVANT_TO_PROMPT } from './dig-grades.ts';
import { inputHash } from './recall-records.ts';
import {
  buildReportFixture,
  copyOfFixtureData,
  promptTextOf,
  reportOn,
  topicBackend,
  type FixturePrompt,
  type ReportFixture,
} from './recall-report.test-support.ts';
import { MEMORY_LIKELY_EXISTS, NO_RELEVANT_MEMORY } from './recall-verdict.ts';
import { runRecall } from './recall.command.ts';
import { harness } from './recall.command.test-support.ts';
import { SPOT_CHECKS_FILE_NAME } from './spot-check-verdicts.ts';

const RED_SERVED: FixturePrompt = {
  label: 'RED_SERVED',
  at: '2026-10-01T10:00:00.000Z',
  sessionId: 'red',
  topic: 'red',
  arm: SERVE_ARM,
  served: ['RED.md'],
  verdict: MEMORY_LIKELY_EXISTS,
  confidence: 0.8,
  reads: [],
  promptKind: 'typed',
};
const BLUE_DUG: FixturePrompt = {
  label: 'BLUE_DUG',
  at: '2026-10-01T10:10:00.000Z',
  sessionId: 'blue',
  topic: 'blue',
  arm: SERVE_ARM,
  served: [],
  verdict: NO_RELEVANT_MEMORY,
  confidence: 0.7,
  reads: [{ minute: '10:11:00', tool: 'Read', memory: 'BLUE.md', readInFull: true }],
  promptKind: 'relayed',
};
const GREEN_SHADOW: FixturePrompt = {
  label: 'GREEN_SHADOW',
  at: '2026-10-01T10:20:00.000Z',
  sessionId: 'green',
  topic: 'green',
  arm: SHADOW_ARM,
  served: ['GREEN.md'],
  verdict: MEMORY_LIKELY_EXISTS,
  confidence: 0.9,
  reads: [],
  promptKind: 'typed',
};
const NEVER_GRADED: FixturePrompt = { ...RED_SERVED, label: 'NEVER_GRADED', at: '2026-10-01T10:30:00.000Z', sessionId: 'never' };

function gradeLine(prompt: FixturePrompt, memoryFile: string, pick: string, probability: number): object {
  return {
    at: '2026-10-02T00:00:00.000Z',
    question: RELEVANT_TO_PROMPT,
    against: inputHash(promptTextOf(prompt)),
    memoryFile,
    pick,
    probability,
    backend: 'jev',
    failedOpen: false,
  };
}

async function gradedFixture(): Promise<{ readonly fixture: ReportFixture; readonly dataDirectory: string }> {
  const fixture = buildReportFixture([RED_SERVED, BLUE_DUG, GREEN_SHADOW, NEVER_GRADED]);
  const dataDirectory = copyOfFixtureData(fixture);
  const grades = [
    gradeLine(RED_SERVED, fixture.memoryPath('RED.md'), YES, 0.9),
    gradeLine(BLUE_DUG, fixture.memoryPath('BLUE.md'), YES, 0.8),
    gradeLine(BLUE_DUG, fixture.memoryPath('RED.md'), NO, 0.7),
    gradeLine(GREEN_SHADOW, fixture.memoryPath('GREEN.md'), YES, 0.95),
  ];
  await writeFile(
    path.join(dataDirectory, GRADES_FILE_NAME),
    grades.map((grade) => `${JSON.stringify(grade)}\n`).join(''),
  );
  return { fixture, dataDirectory };
}

async function recall(commandArguments: readonly string[], dataDirectory: string) {
  const run = harness();
  const exitCode = await runRecall(commandArguments, { ...run.dependencies, dataDirectory });
  return { exitCode, stdout: run.stdout.join(''), stderr: run.stderr.join('') };
}

function spotCheckIdsIn(output: string): readonly string[] {
  return [...output.matchAll(/^\[([0-9a-f]+)\]/gm)].map((match) => match[1] as string);
}

async function spotCheckLines(dataDirectory: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path.join(dataDirectory, SPOT_CHECKS_FILE_NAME), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a spot check prints the requested number of graded prompts with their grades', async () => {
  const { dataDirectory } = await gradedFixture();

  const two = await recall(['--spot-check', '--count', '2'], dataDirectory);
  assert.equal(two.exitCode, 0);
  assert.match(two.stdout, /^Spot check: 2 of 3 graded prompts, chosen at random\n/);
  assert.equal(spotCheckIdsIn(two.stdout).length, 2);

  const everyOne = await recall(['--spot-check'], dataDirectory);
  assert.equal(spotCheckIdsIn(everyOne.stdout).length, 3);
  assert.doesNotMatch(everyOne.stdout, /NEVER_GRADED/);
  assert.match(
    everyOne.stdout,
    /\] 2026-10-01T10:10:00\.000Z serve arm, relayed prompt\n {2}prompt: "BLUE_DUG: fix the topic-blue problem"\n {2}Jev served: nothing\n {2}the dig found: BLUE\.md\n {2}the judge graded:\n {4}relevant-to-prompt BLUE\.md: yes \(probability 0\.80\)\n {4}relevant-to-prompt RED\.md: no \(probability 0\.70\)\n/,
  );
  assert.match(
    everyOne.stdout,
    /\] 2026-10-01T10:20:00\.000Z shadow arm, typed prompt\n {2}prompt: "GREEN_SHADOW: fix the topic-green problem"\n {2}Jev would have served: GREEN\.md\n {2}the dig found: no dig\n {2}the judge graded:\n {4}relevant-to-prompt GREEN\.md: yes \(probability 0\.95\)\n/,
  );
});

test('agreeing or disagreeing with a graded prompt records the verdict with its reason', async () => {
  const { dataDirectory } = await gradedFixture();
  const [id] = spotCheckIdsIn((await recall(['--spot-check', '--count', '1'], dataDirectory)).stdout);

  assert.equal((await recall(['--agree', id as string], dataDirectory)).exitCode, 0);
  assert.equal(
    (await recall(['--disagree', id as string, 'BLUE is about deploys,', 'not builds'], dataDirectory)).exitCode,
    0,
  );

  assert.deepEqual(await spotCheckLines(dataDirectory), [
    { at: '2026-09-21T00:00:00.000Z', id, verdict: 'agree', reason: null },
    { at: '2026-09-21T00:00:00.000Z', id, verdict: 'disagree', reason: 'BLUE is about deploys, not builds' },
  ]);
});

test('a verdict on an id no graded prompt has is refused and nothing is recorded', async () => {
  const { dataDirectory } = await gradedFixture();
  const neverGradedId = inputHash(`${NEVER_GRADED.at}\n${inputHash(promptTextOf(NEVER_GRADED))}`);

  const refused = await recall(['--disagree', neverGradedId, 'wrong'], dataDirectory);

  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, new RegExp(`no graded prompt has the id ${neverGradedId}`));
  assert.match(refused.stderr, /Ask your supervisor/);
  await assert.rejects(spotCheckLines(dataDirectory), { code: 'ENOENT' });
});

test("the report shows the judge's agreement with the Lord only once there are at least ten verdicts", async () => {
  const { fixture, dataDirectory } = await gradedFixture();
  const [id] = spotCheckIdsIn((await recall(['--spot-check', '--count', '1'], dataDirectory)).stdout);
  await recall(['--disagree', id as string, 'not relevant'], dataDirectory);
  for (let verdict = 1; verdict <= 8; verdict += 1) await recall(['--agree', id as string], dataDirectory);

  const beforeTen = await reportOn(fixture, { backend: topicBackend(), dataDirectory });
  assert.match(
    beforeTen.output,
    /\n {2}judge agreement with the Lord: 9 spot-check verdicts so far, 1 more needed before it is shown \(throne recall --spot-check\)\n/,
  );

  await recall(['--agree', id as string], dataDirectory);
  const atTen = await reportOn(fixture, { backend: topicBackend(), dataDirectory });
  assert.match(atTen.output, /\n {2}judge agreement with the Lord: 90\.0% \(9 of 10 spot-check verdicts\)\n/);
});
