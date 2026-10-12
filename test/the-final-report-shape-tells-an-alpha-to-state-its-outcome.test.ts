import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { missingPhrases, readMarkdownSection } from './skill-contract-test-helpers.ts';
import { parseReportOutcome, ReportOutcomeState } from '../src/reap-agent/report-outcome.ts';
import { QueueOutcome } from '../src/regent-queue/regent-queue-outcome.ts';

const EXECUTE_TODOS_SKILL = resolve(import.meta.dirname, '..', '.claude/skills/execute-todos/SKILL.md');

function fencedMarkdownExamples(section: string): string[] {
  return [...section.matchAll(/```markdown\n([\s\S]*?)```/g)].map((match) => match[1]);
}

test('the final report shape tells an Alpha to state its outcome', async () => {
  const section = readMarkdownSection(await readFile(EXECUTE_TODOS_SKILL, 'utf8'), '## Final report shape');
  const unwrappedSection = section.replace(/\s*\n\s*/g, ' ');

  assert.deepEqual(
    missingPhrases(unwrappedSection, [
      '`REPORT.md` must also carry a `## Outcome` section',
      ...Object.values(QueueOutcome).map((outcome) => `- \`${outcome}\` — `),
    ]),
    [],
  );
  const example = fencedMarkdownExamples(section).find((block) => block.includes('## Outcome'));
  assert.ok(example, 'the section shows the outcome block');
  const reading = parseReportOutcome(example);
  assert.equal(reading.state, ReportOutcomeState.Stated);
  assert.ok(reading.state === ReportOutcomeState.Stated);
  assert.equal(reading.statedOutcome.outcome, QueueOutcome.Merged);
  assert.ok(reading.statedOutcome.outcomeSummary);
  assert.ok(reading.statedOutcome.prUrl);
  assert.ok(reading.statedOutcome.resultCommit);
});
