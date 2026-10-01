import assert from 'node:assert/strict';
import { mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SERVE_ARM, SHADOW_ARM } from '../relevance-classifier/recall-user-config.ts';
import {
  buildReportFixture,
  reportOn,
  topicBackend,
  type FixturePrompt,
} from './recall-report.test-support.ts';
import { NO_RELEVANT_MEMORY } from './recall-verdict.ts';

function typedPrompt(
  label: string,
  at: string,
  topic: string,
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
    reads: [],
    promptKind: 'typed',
    ...extra,
  };
}

function correctionsSection(output: string): string {
  const start = output.indexOf('  corrections an existing memory covered');
  const end = output.indexOf('\n  judge errors:');
  return start === -1 || end === -1 ? output : output.slice(output.indexOf('\n', start) + 1, end + 1);
}

test('a correction that an older memory already covered is counted per 100 typed prompts and shown as an example', async () => {
  const fixture = buildReportFixture([
    typedPrompt('CORRECTED_BLUE', '2026-09-15T10:00:00.000Z', 'blue', { correction: true }),
    typedPrompt('NOT_A_CORRECTION', '2026-09-15T10:10:00.000Z', 'red', { correction: false }),
    typedPrompt('NEVER_JUDGED_FOR_A_CORRECTION', '2026-09-15T10:20:00.000Z', 'green'),
    typedPrompt('RELAYED', '2026-09-15T10:30:00.000Z', 'green', { promptKind: 'relayed' }),
    typedPrompt('SHADOW_TYPED', '2026-09-15T10:40:00.000Z', 'red', { arm: SHADOW_ARM, correction: false }),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(
    correctionsSection(output),
    [
      '    serve arm: 50.0 per 100 typed prompts (1 of 2 typed prompts); corrections recorded: 1',
      '    shadow arm: 0.0 per 100 typed prompts (0 of 1 typed prompts); corrections recorded: 0',
      '    The 1 most recent (at most 10):',
      '      - 2026-09-15T10:00:00.000Z serve arm: "CORRECTED_BLUE: fix the topic-blue problem" | covered by BLUE.md',
      '',
    ].join('\n'),
  );
});

test('a memory written after the correction never counts as having covered it', async () => {
  const fixture = buildReportFixture([
    typedPrompt('CORRECTED_ORANGE', '2026-09-15T10:00:00.000Z', 'orange', { correction: true }),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(
    correctionsSection(output),
    [
      '    serve arm: 0.0 per 100 typed prompts (0 of 1 typed prompts); corrections recorded: 1',
      '    shadow arm: no typed prompts; corrections recorded: 0',
      '    The 0 most recent (at most 10):',
      '',
    ].join('\n'),
  );
});

test('a correction whose lesson an older memory in another repository already recorded counts as covered, and its example says the memory was outside the searched scope', async () => {
  const otherRepositoryMemories = await mkdtemp(path.join(tmpdir(), 'other-repository-memories-'));
  const crawlerMemory = path.join(otherRepositoryMemories, 'CRAWLER.md');
  const writtenBeforeTheCorrection = new Date('2026-09-01T00:00:00Z');
  await writeFile(crawlerMemory, '# The crawler must be running before a sync topic-crawler\n\n- start it first\n');
  await utimes(crawlerMemory, writtenBeforeTheCorrection, writtenBeforeTheCorrection);
  const fixture = buildReportFixture([
    typedPrompt('CORRECTED_CRAWLER', '2026-09-15T10:00:00.000Z', 'crawler', { correction: true }),
  ]);
  const { output } = await reportOn(fixture, {
    backend: topicBackend(),
    everyMemoryDirectory: [fixture.memoriesDirectory, otherRepositoryMemories],
  });
  assert.equal(
    correctionsSection(output),
    [
      '    serve arm: 100.0 per 100 typed prompts (1 of 1 typed prompts); corrections recorded: 1',
      '    shadow arm: no typed prompts; corrections recorded: 0',
      '    The 1 most recent (at most 10):',
      `      - 2026-09-15T10:00:00.000Z serve arm: "CORRECTED_CRAWLER: fix the topic-crawler problem" | covered by CRAWLER.md, outside the memory directories Jev searched (${await realpath(otherRepositoryMemories)})`,
      '',
    ].join('\n'),
  );
});
