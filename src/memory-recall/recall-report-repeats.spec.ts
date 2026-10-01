import assert from 'node:assert/strict';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NO, YES, type ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import { buildReportFixture, reportOn, topicBackend } from './recall-report.test-support.ts';
import { NO_RELEVANT_MEMORY } from './recall-verdict.ts';

const FIXTURE = buildReportFixture([
  {
    label: 'ONLY',
    at: '2026-09-05T10:00:00.000Z',
    sessionId: 'only',
    topic: 'none',
    arm: SERVE_ARM,
    served: [],
    verdict: NO_RELEVANT_MEMORY,
    confidence: 0.9,
    reads: [],
    promptKind: 'typed',
  },
]);
const REPEATS_SECTION = /\n {2}repeat mistakes: [\s\S]*?(?=\n {2}corrections)/;

interface FixtureMemory {
  readonly text: string;
  readonly modifiedAt: string;
}

function incidentsIn(text: unknown): ReadonlySet<string> {
  return new Set(typeof text === 'string' ? (text.match(/incident-[a-z]+/g) ?? []) : []);
}

function incidentBackend(): ClassifierBackend {
  const topics = topicBackend();
  return {
    name: 'jev',
    answer: async (state, questions) => {
      const answers = await topics.answer(state, questions);
      if (typeof state === 'string') return answers;
      return answers.map((answer, index) => {
        if (questions[index]?.stateField !== 'new_note') return answer;
        const newIncidents = incidentsIn(state.new_note);
        const shared = [...incidentsIn(state.memory)].some((incident) => newIncidents.has(incident));
        return { ...answer, pick: shared ? YES : NO };
      });
    },
  };
}

async function repeatsSectionFor(memories: Readonly<Record<string, FixtureMemory>>): Promise<string> {
  const memoriesDirectory = await mkdtemp(path.join(tmpdir(), 'recall-repeats-'));
  for (const [fileName, { text, modifiedAt }] of Object.entries(memories)) {
    const filePath = path.join(memoriesDirectory, fileName);
    await writeFile(filePath, text);
    await utimes(filePath, new Date(modifiedAt), new Date(modifiedAt));
  }
  const { output } = await reportOn({ ...FIXTURE, memoriesDirectory }, { backend: incidentBackend() });
  return REPEATS_SECTION.exec(output)?.[0] ?? output;
}

function note(learned: string, title: string, line: string): string {
  return `---\nlearned: ${learned}\n---\n# ${title}\n\n- ${line}\n`;
}

const DUPLICATES_HEADING =
  '  duplicates (a new memory about the same incident as the existing one, written the same day; not repeat mistakes, which need the existing memory to predate the incident)';

test('two notes about the same incident written the same day by different agents are listed as duplicates, not repeats', async () => {
  const section = await repeatsSectionFor({
    'FIRST_PURPLE.md': {
      text: note('2026-09-10', 'Purple builds hang on the lock topic-purple', 'shadow-first-01, 2026-09-10: the build hung on incident-lockup'),
      modifiedAt: '2026-09-10T08:00:00.000Z',
    },
    'SECOND_PURPLE.md': {
      text: note('2026-09-10', 'Purple builds stall on the lock file topic-purple', 'alpha-second-01, 2026-09-10: saw incident-lockup too'),
      modifiedAt: '2026-09-10T15:00:00.000Z',
    },
  });
  assert.equal(
    section,
    [
      '',
      '  repeat mistakes: 0 (2 new or edited memories checked)',
      `${DUPLICATES_HEADING}: 1`,
      '    - SECOND_PURPLE.md duplicates FIRST_PURPLE.md',
    ].join('\n'),
  );
});

test('a new note repeats an older one only when the older one predates the incident', async () => {
  const olderNoteBeforeTheIncident = await repeatsSectionFor({
    'OLD_CYAN.md': {
      text: note('2026-09-06', 'Cyan caches go stale topic-cyan', 'shadow-first-01: incident-stale'),
      modifiedAt: '2026-09-06T10:00:00.000Z',
    },
    'NEW_CYAN.md': {
      text: note('2026-09-15', 'Cyan caches still go stale topic-cyan', 'alpha-second-01: incident-again'),
      modifiedAt: '2026-09-15T10:00:00.000Z',
    },
  });
  assert.ok(
    olderNoteBeforeTheIncident.includes('repeat mistakes: 1 (2 new or edited memories checked)\n    - NEW_CYAN.md repeats OLD_CYAN.md\n'),
    olderNoteBeforeTheIncident,
  );
  const olderNoteAfterTheIncident = await repeatsSectionFor({
    'ORIGINAL_TEAL.md': {
      text: note('2026-09-12', 'Teal pipelines need a warm cache topic-teal', 'shadow-first-01: incident-cold'),
      modifiedAt: '2026-09-12T10:00:00.000Z',
    },
    'EDITED_TEAL.md': {
      text: note('2026-09-08', 'Teal pipelines want the cache warm topic-teal', 'alpha-second-01: incident-early'),
      modifiedAt: '2026-09-20T10:00:00.000Z',
    },
  });
  assert.equal(
    olderNoteAfterTheIncident,
    ['', '  repeat mistakes: 0 (2 new or edited memories checked)', `${DUPLICATES_HEADING}: 0`].join('\n'),
  );
  const sameDayNoteAboutAnotherIncident = await repeatsSectionFor({
    'AMBER_MORNING.md': {
      text: note('2026-09-18', 'Amber queues drop jobs topic-amber', 'shadow-first-01: incident-fire'),
      modifiedAt: '2026-09-18T06:00:00.000Z',
    },
    'AMBER_EVENING.md': {
      text: note('2026-09-18', 'Amber queues lose jobs topic-amber', 'alpha-second-01: incident-flood'),
      modifiedAt: '2026-09-18T20:00:00.000Z',
    },
  });
  assert.ok(
    sameDayNoteAboutAnotherIncident.includes('repeat mistakes: 1 (2 new or edited memories checked)\n    - AMBER_EVENING.md repeats AMBER_MORNING.md\n'),
    sameDayNoteAboutAnotherIncident,
  );
});
