import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVE_ARM, SHADOW_ARM } from '../relevance-classifier/recall-user-config.ts';
import {
  buildReportFixture,
  reportOn,
  topicBackend,
  type FixturePrompt,
} from './recall-report.test-support.ts';
import { MEMORY_LIKELY_EXISTS, NO_RELEVANT_MEMORY } from './recall-verdict.ts';

const EVERY_PROMPT_HEADING = 'BONUS: verdict calibration over every prompt';
const PROMPTS_WITH_A_DIG_HEADING = 'BONUS: verdict calibration over prompts with a dig';

const PROMPTS_WITHOUT_A_DIG: readonly FixturePrompt[] = [
  { label: 'SERVED_RELEVANT', at: '2026-10-01T10:00:00.000Z', sessionId: 'v-1', topic: 'red', arm: SERVE_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.8, reads: [] },
  { label: 'SERVED_IRRELEVANT', at: '2026-10-01T10:01:00.000Z', sessionId: 'v-2', topic: 'blue', arm: SERVE_ARM, served: ['RED.md'], verdict: MEMORY_LIKELY_EXISTS, confidence: 0.8, reads: [] },
  { label: 'NOTHING_RELEVANT', at: '2026-10-01T10:02:00.000Z', sessionId: 'v-3', topic: 'green', arm: SHADOW_ARM, served: [], verdict: NO_RELEVANT_MEMORY, confidence: 0.9, reads: [] },
  { label: 'RELEVANT_UNDER_NOTHING', at: '2026-10-01T10:03:00.000Z', sessionId: 'v-4', topic: 'red', arm: SHADOW_ARM, served: ['RED.md'], verdict: NO_RELEVANT_MEMORY, confidence: 0.9, reads: [] },
  {
    label: 'NOTHING_THEN_A_DIG',
    at: '2026-10-01T10:04:00.000Z',
    sessionId: 'v-5',
    topic: 'green',
    arm: SERVE_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.9,
    reads: [{ minute: '10:05:00', tool: 'Read', memory: 'GREEN.md', readInFull: true }],
  },
];

const REPORT_ON_PROMPTS_WITHOUT_A_DIG = reportOn(buildReportFixture(PROMPTS_WITHOUT_A_DIG), {
  backend: topicBackend(),
});
const REPORT_ON_THE_FULL_FIXTURE = reportOn(buildReportFixture(), { backend: topicBackend() });

function blockAfter(output: string, heading: string): string {
  return output.slice(output.indexOf(heading)).split('\n\n')[0] ?? '';
}

test('a no-dig prompt whose served memory is graded relevant makes "memory likely exists" right', async () => {
  const { output } = await REPORT_ON_PROMPTS_WITHOUT_A_DIG;
  const everyPrompt = blockAfter(output, EVERY_PROMPT_HEADING);
  assert.ok(
    everyPrompt.includes('  "memory likely exists" was right:\n    confidence 0.8-0.9: 1 of 2\n'),
    everyPrompt,
  );
  const promptsWithADig = blockAfter(output, PROMPTS_WITH_A_DIG_HEADING);
  assert.ok(
    promptsWithADig.includes('  "memory likely exists" was right:\n    no prompt with a dig got this verdict\n'),
    promptsWithADig,
  );
});

test('a no-dig prompt with nothing relevant served and no later dig makes "no relevant memory" right', async () => {
  const { output } = await REPORT_ON_PROMPTS_WITHOUT_A_DIG;
  const everyPrompt = blockAfter(output, EVERY_PROMPT_HEADING);
  assert.ok(
    everyPrompt.includes('  "no relevant memory" was right:\n    confidence 0.9-1.0: 1 of 3\n'),
    everyPrompt,
  );
  assert.ok(
    everyPrompt.includes(
      [
        '  by arm:',
        '    serve arm: "no relevant memory" right at confidence 0.9-1.0 0 of 1; "memory likely exists" right at confidence 0.8-0.9 1 of 2',
        '    shadow arm: "no relevant memory" right at confidence 0.9-1.0 1 of 2; "memory likely exists" given to no prompt',
      ].join('\n'),
    ),
    everyPrompt,
  );
});

test('the report prints the every-prompt table and the dig-only table, each labelled', async () => {
  const { output } = await REPORT_ON_THE_FULL_FIXTURE;
  assert.ok(
    output.includes(
      [
        'BONUS: verdict calibration over every prompt (a prompt with a dig is scored on its dig, as in the next table; a prompt without one is right to say "memory likely exists" when a memory Jev served or would have served was graded relevant, and "no relevant memory" when none was; a prompt whose hook run timed out or errored is left out)',
        '  "no relevant memory" was right:',
        '    confidence 0.6-0.7: 0 of 1',
        '    confidence 0.7-0.8: 0 of 11',
        '    confidence 0.9-1.0: 34 of 34',
        '  "memory likely exists" was right:',
        '    confidence 0.7-0.8: 1 of 1',
        '    confidence 0.8-0.9: 3 of 3',
        '    confidence 0.9-1.0: 0 of 1',
        '  by arm:',
        '    serve arm: "no relevant memory" right at confidence 0.9-1.0 33 of 33; "memory likely exists" right at confidence 0.7-0.8 1 of 1, 0.8-0.9 3 of 3',
        '    shadow arm: "no relevant memory" right at confidence 0.6-0.7 0 of 1, 0.7-0.8 0 of 11, 0.9-1.0 1 of 1; "memory likely exists" right at confidence 0.9-1.0 0 of 1',
        '',
        "BONUS: verdict calibration over prompts with a dig inside the verdict's scope (a dig whose relevant finds all lie outside it, or that followed a timed-out or errored hook run, is left out)",
        '  "no relevant memory" was right:',
        '    confidence 0.6-0.7: 0 of 1',
        '    confidence 0.7-0.8: 0 of 11',
        '    confidence 0.9-1.0: 33 of 33',
      ].join('\n'),
    ),
    output,
  );
});
