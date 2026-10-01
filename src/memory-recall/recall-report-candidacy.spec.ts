import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO } from '../relevance-classifier/classifier.types.ts';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import { NO_RELEVANT_MEMORY } from './recall-verdict.ts';
import {
  buildReportFixture,
  reportOn,
  topicBackend,
  type FixturePrompt,
} from './recall-report.test-support.ts';

const NARROW_ASK = 'Does the task start the topic-purple crawler?';

const FOUND_MEMORY_TEXTS = {
  'PURPLE.md': `---\nname: purple-crawler\ndescription: The topic-purple crawler floods the test sites\nask: ${NARROW_ASK}\n---\n\n# The topic-purple crawler floods the test sites\n\n- turn it off first\n`,
  'TEAL.md': '# Teal caches go stale topic-teal\n\n- flush them\n',
};

function missedPrompt(
  label: string,
  topic: string,
  minute: string,
  logging: Pick<FixturePrompt, 'compactAnswers' | 'everyAnswerLogged'>,
): FixturePrompt {
  return {
    label,
    at: `2026-10-01T10:${minute}:00.000Z`,
    sessionId: `session-${label}`,
    topic,
    arm: SERVE_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.9,
    reads: [{ minute: `10:${minute}:30`, tool: 'Read', memory: `${topic.toUpperCase()}.md`, readInFull: true }],
    promptKind: 'typed',
    ...logging,
  };
}

const FIXTURE = buildReportFixture(
  [
    missedPrompt('JUDGED', 'purple', '01', {
      compactAnswers: [{ memory: 'PURPLE.md', pick: NO, probability: 0.97 }],
      everyAnswerLogged: true,
    }),
    missedPrompt('NEVER', 'teal', '02', { everyAnswerLogged: true }),
    missedPrompt('BEFORE', 'teal', '03', {}),
  ],
  FOUND_MEMORY_TEXTS,
);
const REPORT = reportOn(FIXTURE, { backend: topicBackend() });

function findLinesUnderExample(output: string, label: string): readonly string[] {
  const lines = output.split('\n');
  const exampleIndex = lines.findIndex((line) => line.includes(`"${label}: fix the`));
  assert.notEqual(exampleIndex, -1, `no missed-and-found example for ${label}`);
  const following = lines.slice(exampleIndex + 1);
  const nextExample = following.findIndex((line) => !line.startsWith('      '));
  return following.slice(0, nextExample === -1 ? following.length : nextExample);
}

test('the report shows, for a memory the dig found that Jev judged and rejected, Jev\'s probability of yes and the memory\'s ask', async () => {
  const { output, exitCode } = await REPORT;
  assert.equal(exitCode, 0);
  assert.deepEqual(findLinesUnderExample(output, 'JUDGED'), [
    `      PURPLE.md: judged, Jev's probability of yes 0.03 | ask: "${NARROW_ASK}"`,
  ]);
});

test('the report says a memory the dig found was never a candidate when every answer was logged and none names it', async () => {
  const { output } = await REPORT;
  assert.deepEqual(findLinesUnderExample(output, 'NEVER'), [
    '      TEAL.md: never a candidate (every answer was logged and none names it) | no ask',
  ]);
});

test('the report says the candidacy of a found memory is unknown for a prompt logged before every answer was logged', async () => {
  const { output } = await REPORT;
  assert.deepEqual(findLinesUnderExample(output, 'BEFORE'), [
    '      TEAL.md: candidacy unknown (logged before every answer was logged, so it was judged below 0.1 or never asked) | no ask',
  ]);
});
