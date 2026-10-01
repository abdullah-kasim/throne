import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import { GRADES_FILE_NAME } from './dig-grades.ts';
import {
  CLASSIFIER_ERROR_OUTCOME,
  NOTHING_RELEVANT_OUTCOME,
  TIMED_OUT_OUTCOME,
} from './hook-outcome.ts';
import { MEMORY_VERSIONS_DIRECTORY_NAME, contentHashOf } from './memory-versions.ts';
import { MEMORY_READ_LOG_FILE_NAME } from './recall-report-logs.ts';
import {
  buildReportFixture,
  copyOfFixtureData,
  reportOn,
  topicBackend,
  type FixturePrompt,
} from './recall-report.test-support.ts';
import { NO_RELEVANT_MEMORY } from './recall-verdict.ts';

const MAIN_SERVE_ARM_LINE = /MAIN: missed-and-found[^\n]*\n {4}serve arm: ([^\n]*)\n/;
const OLD_MEMORY_TIME = new Date('2026-09-01T00:00:00Z');

function promptWithADig(
  label: string,
  at: string,
  topic: string,
  reads: FixturePrompt['reads'],
  extra: Partial<FixturePrompt> = {},
): FixturePrompt {
  return {
    label,
    at,
    sessionId: `session-${label}`,
    topic,
    arm: SERVE_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.9,
    reads,
    promptKind: 'typed',
    ...extra,
  };
}

function fullReadOf(at: string, memory: string): FixturePrompt['reads'][number] {
  return { minute: at.slice(11, 19), tool: 'Read', memory, readInFull: true };
}

function mainServeArmLine(output: string): string {
  return MAIN_SERVE_ARM_LINE.exec(output)?.[1] ?? output;
}

test('a memory created after the prompt is listed as its own later note and never counted as a find', async () => {
  const fixture = buildReportFixture([
    promptWithADig('LATER', '2026-09-15T10:00:00.000Z', 'orange', [fullReadOf('2026-09-15T10:05:00', 'NEW_ORANGE.md')]),
    promptWithADig('EXISTED', '2026-09-15T10:10:00.000Z', 'red', [fullReadOf('2026-09-15T10:15:00', 'RED.md')]),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(mainServeArmLine(output), '50.0 per 100 prompts (1 of 2 prompts)');
  assert.match(
    output,
    /\n {4}found its own later note \(the memory was created after the prompt\): 1\n {6}- 2026-09-15T10:00:00\.000Z "LATER: fix the topic-orange problem" \| found NEW_ORANGE\.md, created \d{4}-/,
  );
  assert.ok(!output.includes('the dig found: NEW_ORANGE.md'), output);
});

test('a dig after a timed-out or errored hook run is listed apart and never counted as a miss', async () => {
  const fixture = buildReportFixture([
    promptWithADig('TIMED_OUT', '2026-10-01T10:00:00.000Z', 'red', [fullReadOf('2026-10-01T10:01:00', 'RED.md')], { hookOutcome: TIMED_OUT_OUTCOME }),
    promptWithADig('ERRORED', '2026-10-01T10:10:00.000Z', 'blue', [fullReadOf('2026-10-01T10:11:00', 'BLUE.md')], { hookOutcome: CLASSIFIER_ERROR_OUTCOME }),
    promptWithADig('WORKED', '2026-10-01T10:20:00.000Z', 'green', [fullReadOf('2026-10-01T10:21:00', 'GREEN.md')], { hookOutcome: NOTHING_RELEVANT_OUTCOME }),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(mainServeArmLine(output), '33.3 per 100 prompts (1 of 3 prompts)');
  assert.ok(
    output.includes(
      '    after a timed-out or errored hook run: 2 prompts with a dig, 2 relevant finds (neither missed-and-found nor out of scope)\n',
    ),
    output,
  );
  assert.ok(output.includes('"no relevant memory" was right:\n    confidence 0.9-1.0: 0 of 1\n'), output);
});

test('a dig that finds a memory suppressed as already shown is listed apart and not counted as a miss', async () => {
  const fixture = buildReportFixture([
    promptWithADig('SUPPRESSED', '2026-10-01T10:00:00.000Z', 'red', [fullReadOf('2026-10-01T10:01:00', 'RED.md')], { suppressed: ['RED.md'] }),
    promptWithADig('NOT_SUPPRESSED', '2026-10-01T10:10:00.000Z', 'blue', [fullReadOf('2026-10-01T10:11:00', 'BLUE.md')]),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(mainServeArmLine(output), '50.0 per 100 prompts (1 of 2 prompts)');
  assert.ok(output.includes('    already shown earlier in the session (suppressed as a repeat): 1\n'), output);
});

test('a memory spelled through a symlinked directory is matched as the same memory when deciding whether it was already shown', async () => {
  const fixture = buildReportFixture([
    promptWithADig('SUPPRESSED', '2026-10-01T10:00:00.000Z', 'red', [fullReadOf('2026-10-01T10:01:00', 'RED.md')], { suppressed: ['RED.md'] }),
    promptWithADig('SERVED', '2026-10-01T10:10:00.000Z', 'blue', [fullReadOf('2026-10-01T10:11:00', 'BLUE.md')], { served: ['BLUE.md'] }),
  ]);
  const linkedMemoriesDirectory = path.join(path.dirname(fixture.memoriesDirectory), 'linked-memories');
  await symlink(fixture.memoriesDirectory, linkedMemoriesDirectory);
  const dataDirectory = copyOfFixtureData(fixture);
  const readLog = path.join(dataDirectory, MEMORY_READ_LOG_FILE_NAME);
  await writeFile(
    readLog,
    (await readFile(readLog, 'utf8')).replaceAll(`${fixture.memoriesDirectory}${path.sep}`, `${linkedMemoriesDirectory}${path.sep}`),
  );
  const { output } = await reportOn(fixture, { backend: topicBackend(), dataDirectory });
  assert.ok(!output.includes('| the dig found:'), output);
  assert.equal(mainServeArmLine(output), '0.0 per 100 prompts (0 of 2 prompts)');
  assert.ok(output.includes('    already shown earlier in the session (suppressed as a repeat): 1\n'), output);
});

test('a search whose output named a memory counts as having found it', async () => {
  const fixture = buildReportFixture([
    promptWithADig('GREP', '2026-10-01T10:00:00.000Z', 'red', [{ minute: '10:01:00', tool: 'Grep', memory: 'RED.md', returnedSomething: true }]),
    promptWithADig('FIND', '2026-10-01T10:10:00.000Z', 'blue', [{ minute: '10:11:00', tool: 'Bash', memory: 'BLUE.md', returnedSomething: true }]),
    promptWithADig('NOTHING_NAMED', '2026-10-01T10:20:00.000Z', 'green', [{ minute: '10:21:00', tool: 'Grep', memory: 'GREEN.md', returnedSomething: false }]),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(mainServeArmLine(output), '66.7 per 100 prompts (2 of 3 prompts)');
  assert.ok(output.includes('| the dig found: RED.md'), output);
  assert.ok(output.includes('| the dig found: BLUE.md'), output);
});

test('a find is graded on the version of the memory that was read', async () => {
  const keptVersionText = '# Teal pipelines need a warm cache topic-teal\n\n- warm it first\n';
  const fixture = buildReportFixture([
    promptWithADig('READ_THE_TEAL_VERSION', '2026-10-01T10:00:00.000Z', 'teal', [
      { minute: '10:01:00', tool: 'Read', memory: 'REWRITTEN.md', readInFull: true, contentHash: contentHashOf(keptVersionText) },
    ]),
    promptWithADig('READ_TODAYS_VERSION', '2026-10-01T10:10:00.000Z', 'teal', [fullReadOf('2026-10-01T10:11:00', 'REWRITTEN.md')]),
  ]);
  const rewrittenMemory = fixture.memoryPath('REWRITTEN.md');
  await writeFile(rewrittenMemory, '# Purple pipelines need a cold start topic-purple\n\n- start cold\n');
  await utimes(rewrittenMemory, OLD_MEMORY_TIME, OLD_MEMORY_TIME);
  const dataDirectory = copyOfFixtureData(fixture);
  await mkdir(path.join(dataDirectory, MEMORY_VERSIONS_DIRECTORY_NAME));
  await writeFile(
    path.join(dataDirectory, MEMORY_VERSIONS_DIRECTORY_NAME, contentHashOf(keptVersionText)),
    keptVersionText,
  );
  const { output } = await reportOn(fixture, { backend: topicBackend(), dataDirectory });
  assert.equal(mainServeArmLine(output), '50.0 per 100 prompts (1 of 2 prompts)');
  assert.ok(output.includes('"READ_THE_TEAL_VERSION: fix the topic-teal problem" | Jev served: nothing | the dig found: REWRITTEN.md'), output);
  const gradesOfTheRewrittenMemory = (await readFile(path.join(dataDirectory, GRADES_FILE_NAME), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((grade) => grade.memoryFile === rewrittenMemory);
  assert.deepEqual(
    gradesOfTheRewrittenMemory.map((grade) => [grade.pick, grade.contentHash]),
    [
      ['yes', contentHashOf(keptVersionText)],
      ['no', undefined],
    ],
  );
});
