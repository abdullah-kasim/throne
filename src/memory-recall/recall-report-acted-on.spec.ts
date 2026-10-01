import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import {
  buildReportFixture,
  reportOn,
  topicBackend,
  type FixturePrompt,
} from './recall-report.test-support.ts';
import { MEMORY_LIKELY_EXISTS } from './recall-verdict.ts';

const PROMPT_TIME = '2026-10-01T10:00:00.000Z';

type Block =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'tool_use'; readonly name: string; readonly input: object };

interface TranscriptLine {
  readonly type: 'assistant' | 'user';
  readonly second: number;
  readonly turn: string;
  readonly blocks: readonly Block[];
}

function text(value: string): Block {
  return { type: 'text', text: value };
}

function assistant(second: number, turn: string, ...blocks: Block[]): TranscriptLine {
  return { type: 'assistant', second, turn, blocks };
}

async function writeTranscript(lines: readonly TranscriptLine[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'recall-transcript-'));
  const transcriptPath = path.join(directory, 'session.jsonl');
  const promptTime = Date.parse(PROMPT_TIME);
  await writeFile(
    transcriptPath,
    lines
      .map((line) =>
        JSON.stringify({
          type: line.type,
          timestamp: new Date(promptTime + line.second * 1000).toISOString(),
          message: { id: line.turn, role: line.type, content: line.blocks },
        }),
      )
      .map((line) => `${line}\n`)
      .join(''),
  );
  return transcriptPath;
}

function servedRedMemory(label: string, extra: Partial<FixturePrompt> = {}): FixturePrompt {
  return {
    label,
    at: PROMPT_TIME,
    sessionId: `session-${label}`,
    topic: 'red',
    arm: SERVE_ARM,
    served: ['RED.md'],
    verdict: MEMORY_LIKELY_EXISTS,
    confidence: 0.8,
    reads: [],
    promptKind: 'typed',
    ...extra,
  };
}

function actedOnSection(output: string): string {
  const start = output.indexOf('  acted on (');
  const end = output.indexOf('\n  empty-handed serves');
  return start === -1 || end === -1 ? output : output.slice(start, end + 1);
}

function actedOnByPromptKind(output: string): string {
  const start = output.indexOf('    acted on:\n');
  const end = output.indexOf('    empty-handed serves:\n');
  return start === -1 || end === -1 ? output : output.slice(start, end);
}

test('a relevant served memory that the next assistant turns cite or follow counts as acted on', async () => {
  const citedInText = await writeTranscript([
    assistant(1, 'turn-1', text('Clearing the build cache first, as the topic-red memory says.')),
  ]);
  const followedThroughATool = await writeTranscript([
    assistant(1, 'turn-1', text('Looking around.')),
    assistant(2, 'turn-2', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }),
    assistant(3, 'turn-3', text('Now the build.')),
    assistant(4, 'turn-3', { type: 'tool_use', name: 'Bash', input: { command: 'make clean-cache topic-red' } }),
  ]);
  const onlyOutsideTheFiveTurns = await writeTranscript([
    assistant(-5, 'before', text('topic-red from an earlier prompt')),
    assistant(1, 'turn-1', { type: 'thinking', thinking: 'maybe topic-red applies' }, text('Starting.')),
    { type: 'user', second: 2, turn: 'result', blocks: [text('topic-red in a tool result')] },
    assistant(3, 'turn-2', text('two')),
    assistant(4, 'turn-3', text('three')),
    assistant(5, 'turn-4', text('four')),
    assistant(6, 'turn-5', text('five')),
    assistant(7, 'turn-6', text('Only now clearing the topic-red cache.')),
  ]);
  const servedButIrrelevant = await writeTranscript([assistant(1, 'turn-1', text('topic-red everywhere'))]);
  const fixture = buildReportFixture([
    servedRedMemory('CITED', { transcriptPath: citedInText }),
    servedRedMemory('FOLLOWED', { transcriptPath: followedThroughATool }),
    servedRedMemory('IGNORED', { transcriptPath: onlyOutsideTheFiveTurns }),
    servedRedMemory('BLUE_TASK', { topic: 'blue', transcriptPath: servedButIrrelevant }),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(
    actedOnSection(output),
    [
      '  acted on (a served memory graded relevant that the agent cited or followed within the next 5 assistant turns; a memory whose transcript is missing, unreadable or has no assistant turn after the prompt is counted apart):',
      '    serve arm: 66.7% (2 of 3 relevant served memories); transcript unavailable: 0',
      '    shadow arm: no data (0 relevant served memories); transcript unavailable: 0',
      '',
    ].join('\n'),
  );
  assert.equal(
    actedOnByPromptKind(output),
    [
      '    acted on:',
      '      typed prompts: 66.7% (2 of 3 relevant served memories); transcript unavailable: 0',
      '      relayed prompts: no data (0 relevant served memories); transcript unavailable: 0',
      '      task-notification prompts: no data (0 relevant served memories); transcript unavailable: 0',
      '      other prompts: no data (0 relevant served memories); transcript unavailable: 0',
      '',
    ].join('\n'),
  );
});

test('a served memory whose transcript cannot be read is counted apart, not as ignored', async () => {
  const fixture = buildReportFixture([
    servedRedMemory('TRANSCRIPT_GONE', {
      transcriptPath: path.join(tmpdir(), 'recall-transcript-that-does-not-exist.jsonl'),
    }),
    servedRedMemory('NO_TRANSCRIPT_RECORDED'),
    servedRedMemory('NO_TURN_YET', { transcriptPath: await writeTranscript([]) }),
  ]);
  const { output } = await reportOn(fixture, { backend: topicBackend() });
  assert.equal(
    actedOnSection(output),
    [
      '  acted on (a served memory graded relevant that the agent cited or followed within the next 5 assistant turns; a memory whose transcript is missing, unreadable or has no assistant turn after the prompt is counted apart):',
      '    serve arm: no data (0 relevant served memories); transcript unavailable: 3',
      '    shadow arm: no data (0 relevant served memories); transcript unavailable: 0',
      '',
    ].join('\n'),
  );
});
