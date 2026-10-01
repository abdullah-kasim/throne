import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SERVE_ARM } from '../relevance-classifier/recall-user-config.ts';
import { memoriesTheDigTurnedUp, digEpisodesOf } from './dig-episodes.ts';
import {
  GRADES_FILE_NAME,
  RELEVANT_TO_PROMPT,
  gradeEach,
  gradeKey,
  isRelevant,
} from './dig-grades.ts';
import { MEMORY_READ_LOG_FILE_NAME, readRecallReportLogs } from './recall-report-logs.ts';
import {
  FAILING_JEV_BACKEND,
  FIXTURE_PROMPTS,
  REPORT_TIME,
  buildReportFixture,
  copyOfFixtureData,
  promptTextOf,
  reportOn,
  topicBackend,
} from './recall-report.test-support.ts';
import { PROMPT_LOG_FILE_NAME, RECALL_LEDGER_FILE_NAME, inputHash } from './recall-records.ts';
import { runRecall } from './recall.command.ts';
import { HOOK_PAYLOAD, harness, ledgerEntries } from './recall.command.test-support.ts';

const FIXTURE = buildReportFixture();
const REPORT_OVER_ALL_TIME = reportOn(FIXTURE, { backend: topicBackend() });

async function episodesOfTheFixture() {
  const logs = await readRecallReportLogs(FIXTURE.dataDirectory, undefined);
  return digEpisodesOf(logs.prompts, logs.memoryReads);
}

function entryLabelled(
  episodes: Awaited<ReturnType<typeof episodesOfTheFixture>>,
  label: string,
) {
  const prompt = FIXTURE_PROMPTS.find((candidate) => candidate.label === label);
  assert.ok(prompt !== undefined);
  const entry = episodes.prompts.find(
    (candidate) => candidate.prompt.promptText === promptTextOf(prompt),
  );
  assert.ok(entry !== undefined);
  return entry;
}

function gradeLines(dataDirectory: string): Record<string, unknown>[] {
  return readFileSync(path.join(dataDirectory, GRADES_FILE_NAME), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('memory reads between two prompts of the same session form one dig episode for the first prompt', async () => {
  const episodes = await episodesOfTheFixture();
  assert.deepEqual(
    entryLabelled(episodes, 'D').digReads.map((read) => read.at),
    ['2026-10-01T11:01:00.000Z', '2026-10-01T11:02:00.000Z'],
  );
  assert.deepEqual(
    entryLabelled(episodes, 'E').digReads.map((read) => read.at),
    ['2026-10-01T11:11:00.000Z'],
  );
  assert.deepEqual(entryLabelled(episodes, 'A').digReads, []);
  assert.deepEqual(
    entryLabelled(episodes, 'B').digReads.map((read) => read.at),
    ['2026-10-01T10:12:00.000Z'],
  );
  assert.equal(episodes.readsMatchedToNoPrompt, 3);
});

test('a dig found something only when the judge rates a fully read or grep-matched memory relevant to the prompt', async () => {
  const episodes = await episodesOfTheFixture();
  const partlyReadAndListed = entryLabelled(episodes, 'C');
  const grepMatched = entryLabelled(episodes, 'D');
  const indexOnly = entryLabelled(episodes, 'E');
  assert.deepEqual(memoriesTheDigTurnedUp(partlyReadAndListed), [FIXTURE.memoryPath('RED.md')]);
  assert.deepEqual(memoriesTheDigTurnedUp(grepMatched), [FIXTURE.memoryPath('BLUE.md')]);
  assert.deepEqual(memoriesTheDigTurnedUp(indexOnly), []);
  const grades = await gradeEach(
    [partlyReadAndListed, grepMatched].map((entry) => ({
      question: RELEVANT_TO_PROMPT,
      against: entry.prompt.inputHash,
      againstText: entry.prompt.promptText,
      memoryFile: memoriesTheDigTurnedUp(entry)[0] as string,
    })),
    {
      backend: topicBackend(),
      dataDirectory: copyOfFixtureData(FIXTURE),
      now: () => REPORT_TIME,
    },
  );
  assert.equal(
    isRelevant(grades.get(gradeKey(RELEVANT_TO_PROMPT, partlyReadAndListed.prompt.inputHash, FIXTURE.memoryPath('RED.md')))),
    false,
  );
  assert.equal(
    isRelevant(grades.get(gradeKey(RELEVANT_TO_PROMPT, grepMatched.prompt.inputHash, FIXTURE.memoryPath('BLUE.md')))),
    true,
  );
});

test('each grade is stored and reused instead of being asked again', async () => {
  const dataDirectory = copyOfFixtureData(FIXTURE);
  const firstBackend = topicBackend();
  const first = await reportOn(FIXTURE, { backend: firstBackend, dataDirectory });
  const gradesAfterTheFirstRun = gradeLines(dataDirectory);
  const secondBackend = topicBackend();
  const second = await reportOn(FIXTURE, { backend: secondBackend, dataDirectory });
  assert.equal(firstBackend.judgeQuestionCount(), 53);
  assert.equal(gradesAfterTheFirstRun.length, 53);
  assert.equal(secondBackend.judgeQuestionCount(), 0);
  assert.equal(gradeLines(dataDirectory).length, 53);
  assert.equal(second.output, first.output);
  const bluePromptGrade = gradesAfterTheFirstRun.find(
    (grade) =>
      grade.against === inputHash(promptTextOf({ label: 'B', topic: 'blue' })) &&
      grade.memoryFile === FIXTURE.memoryPath('BLUE.md'),
  );
  assert.deepEqual(bluePromptGrade, {
    at: REPORT_TIME.toISOString(),
    question: RELEVANT_TO_PROMPT,
    against: inputHash(promptTextOf({ label: 'B', topic: 'blue' })),
    memoryFile: FIXTURE.memoryPath('BLUE.md'),
    pick: 'yes',
    probability: 0.9,
    backend: 'jev',
    failedOpen: false,
  });
});

test("the judge model reads the prompt and the memory's text whenever Jev is switched on, whatever rank's allowed roots say", async () => {
  const backend = topicBackend();
  const { output } = await reportOn(FIXTURE, { backend, rankAllowedRoots: [] });
  assert.equal(backend.judgeQuestionCount(), 53);
  assert.ok(output.includes('  judge errors: 0.0% (0 of 53 grades)\n  judged by: jev 53\n'), output);
  assert.ok(
    output.includes(
      '    serve arm: 2.7 per 100 prompts (1 of 37 prompts)\n    shadow arm: 85.7 per 100 prompts (12 of 14 prompts)\n',
    ),
    output,
  );
});

test('a dig that finds a memory Jev served earlier in the same session is not counted as missed and found', async () => {
  const fixture = harness({ hookEnabled: true, hookMode: SERVE_ARM });
  const promptAt = (at: string) =>
    runRecall(['--hook'], {
      ...fixture.dependencies,
      now: () => new Date(at),
      readStdin: () => Promise.resolve(HOOK_PAYLOAD),
    });
  await promptAt('2026-10-01T10:00:00.000Z');
  await promptAt('2026-10-01T10:10:00.000Z');
  const servedMemory = String(ledgerEntries(fixture.dataDirectory).find((line) => line.served === true)?.questionId);
  writeFileSync(
    path.join(fixture.dataDirectory, MEMORY_READ_LOG_FILE_NAME),
    `${JSON.stringify({ at: '2026-10-01T10:11:00.000Z', sessionId: 'abc', kind: 'read', memoryFiles: [servedMemory], returnedSomething: true, readInFull: true })}\n`,
  );
  await runRecall(['--report'], { ...fixture.dependencies, now: () => REPORT_TIME });
  const output = fixture.stdout.join('');
  assert.ok(
    output.includes(
      'MAIN: missed-and-found (Jev served nothing relevant, then a dig found a relevant memory in the memory directories Jev searched that Jev did not serve)\n    serve arm: 0.0 per 100 prompts (0 of 2 prompts)\n',
    ),
    output,
  );
  assert.ok(output.includes('  dig episodes:\n    serve arm: 50.0 per 100 prompts (1 of 2 prompts)\n'), output);
});

test('the judge falls back to the rules backend when Jev fails, and the report counts it as a judge error', async () => {
  const run = await reportOn(FIXTURE, { backend: FAILING_JEV_BACKEND });
  const grades = gradeLines(run.dataDirectory);
  assert.equal(grades.length, 51);
  assert.ok(grades.every((grade) => grade.backend === 'rules' && grade.failedOpen === true));
  assert.ok(run.output.includes('  judge errors: 100.0% (51 of 51 grades)\n  judged by: rules 51\n'));
});

test('the report shows the missed-and-found rate per 100 prompts by arm with the ten most recent examples', async () => {
  const { output, exitCode } = await REPORT_OVER_ALL_TIME;
  assert.equal(exitCode, 0);
  const examples = Array.from({ length: 10 }, (_, index) => [
    `    - 2026-10-01T12:${String(11 - index).padStart(2, '0')}:00.000Z shadow arm: "G${11 - index}: fix the topic-green problem" | Jev served: nothing | the dig found: GREEN.md`,
    '      GREEN.md: candidacy unknown (logged before every answer was logged, so it was judged below 0.1 or never asked) | no ask',
  ]).flat();
  assert.ok(
    output.includes(
      [
        'MAIN: missed-and-found (Jev served nothing relevant, then a dig found a relevant memory in the memory directories Jev searched that Jev did not serve)',
        '    serve arm: 2.7 per 100 prompts (1 of 37 prompts)',
        '    shadow arm: 85.7 per 100 prompts (12 of 14 prompts)',
        '  The 10 most recent (at most 10):',
        ...examples,
        '',
      ].join('\n'),
    ),
    output,
  );
});

test('the report shows how often each verdict was right by confidence, and the confidence above which nothing was right 95 percent of the time on at least 30 episodes', async () => {
  const { output } = await REPORT_OVER_ALL_TIME;
  assert.ok(
    output.includes(
      [
        "BONUS: verdict calibration over prompts with a dig inside the verdict's scope (a dig whose relevant finds all lie outside it, or that followed a timed-out or errored hook run, is left out)",
        '  "no relevant memory" was right:',
        '    confidence 0.6-0.7: 0 of 1',
        '    confidence 0.7-0.8: 0 of 11',
        '    confidence 0.9-1.0: 33 of 33',
        '  "memory likely exists" was right:',
        '    confidence 0.7-0.8: 1 of 1',
        '    confidence 0.9-1.0: 0 of 1',
        '  "no relevant memory" was right at least 95% of the time from confidence 0.8 up (33 of 33 episodes).',
        '',
      ].join('\n'),
    ),
    output,
  );
});

test('the report shows digs per 100 prompts, useful serves, empty-handed serves, judge errors and cost per day by arm', async () => {
  const { output } = await REPORT_OVER_ALL_TIME;
  assert.ok(
    output.includes(
      [
        '  dig episodes:',
        '    serve arm: 91.9 per 100 prompts (34 of 37 prompts)',
        '    shadow arm: 92.9 per 100 prompts (13 of 14 prompts)',
        '  useful serves (at least one served memory graded relevant):',
        '    serve arm: 75.0% (3 of 4 prompts that served something)',
        '    shadow arm: 100.0% (1 of 1 prompts that served something)',
        '  acted on (a served memory graded relevant that the agent cited or followed within the next 5 assistant turns; a memory whose transcript is missing, unreadable or has no assistant turn after the prompt is counted apart):',
        '    serve arm: no data (0 relevant served memories); transcript unavailable: 3',
        '    shadow arm: no data (0 relevant served memories); transcript unavailable: 1',
        '  empty-handed serves (everything served graded irrelevant, and a dig followed):',
        '    serve arm: 25.0% (1 of 4 prompts that served something)',
        '    shadow arm: 0.0% (0 of 1 prompts that served something)',
      ].join('\n'),
    ),
    output,
  );
  assert.ok(
    output.includes(
      [
        '  judge errors: 0.0% (0 of 53 grades)',
        '  judged by: jev 53',
        '  judge agreement with the Lord: 0 spot-check verdicts so far, 10 more needed before it is shown (throne recall --spot-check)',
        '  cost per day (classifier questions):',
        '    2026-09-30: recall jev 6; judge none',
        '    2026-10-01: recall jev 147; judge none',
        '    2026-10-02: recall none; judge jev 53',
        '',
      ].join('\n'),
    ),
    output,
  );
});

test('a new memory whose lesson an existing memory already holds is counted as a repeat mistake', async () => {
  const { output } = await REPORT_OVER_ALL_TIME;
  assert.ok(
    output.includes(
      '  repeat mistakes: 1 (2 new or edited memories checked)\n    - NEW_BLUE_AGAIN.md repeats BLUE.md\n',
    ),
    output,
  );
});

test('the report counts memory-read logging failures', async () => {
  const { output } = await REPORT_OVER_ALL_TIME;
  assert.ok(output.includes('  memory-read logging failures: 2\n  memory reads matched to no prompt: 3\n'), output);
});

test('the report only counts prompts after --since', async () => {
  const { output, exitCode } = await reportOn(FIXTURE, {
    backend: topicBackend(),
    flags: ['--since', '2026-10-01'],
  });
  assert.equal(exitCode, 0);
  assert.ok(output.startsWith('Jev recall report, since 2026-10-01T00:00:00.000Z\n'), output);
  assert.ok(output.includes('    serve arm: 2.9 per 100 prompts (1 of 35 prompts)\n'), output);
  assert.ok(output.includes('    serve arm: 50.0% (1 of 2 prompts that served something)\n'), output);
  assert.ok(output.includes('  memory-read logging failures: 1\n'), output);
  assert.ok(!output.includes('2026-09-30'), output);
  const refused = await reportOn(FIXTURE, { backend: topicBackend(), flags: ['--since', 'last tuesday'] });
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.output, '');
});

test('every report metric is shown for each prompt kind as well as for each arm', async () => {
  const { output } = await REPORT_OVER_ALL_TIME;
  assert.ok(output.includes('    serve arm: 91.9 per 100 prompts (34 of 37 prompts)\n'), output);
  assert.ok(
    output.includes(
      [
        '  by prompt kind:',
        '    missed-and-found:',
        '      typed prompts: 25.0 per 100 prompts (11 of 44 prompts)',
        '      relayed prompts: 66.7 per 100 prompts (2 of 3 prompts)',
        '      task-notification prompts: 0.0 per 100 prompts (0 of 2 prompts)',
        '      other prompts: 0.0 per 100 prompts (0 of 2 prompts)',
        '    out of scope:',
        "      typed prompts: 0.0 per 100 prompts (0 of 44 prompts); 0 of 0 first ran throne recall with that repository's scope; 0 of 0 had recall list that repository among the other repositories",
        "      relayed prompts: 0.0 per 100 prompts (0 of 3 prompts); 0 of 0 first ran throne recall with that repository's scope; 0 of 0 had recall list that repository among the other repositories",
        "      task-notification prompts: 0.0 per 100 prompts (0 of 2 prompts); 0 of 0 first ran throne recall with that repository's scope; 0 of 0 had recall list that repository among the other repositories",
        "      other prompts: 0.0 per 100 prompts (0 of 2 prompts); 0 of 0 first ran throne recall with that repository's scope; 0 of 0 had recall list that repository among the other repositories",
        '    dig episodes:',
        '      typed prompts: 100.0 per 100 prompts (44 of 44 prompts)',
        '      relayed prompts: 66.7 per 100 prompts (2 of 3 prompts)',
        '      task-notification prompts: 50.0 per 100 prompts (1 of 2 prompts)',
        '      other prompts: 0.0 per 100 prompts (0 of 2 prompts)',
        '    useful serves:',
        '      typed prompts: 100.0% (1 of 1 prompts that served something)',
        '      relayed prompts: 50.0% (1 of 2 prompts that served something)',
        '      task-notification prompts: no data (0 prompts that served something)',
        '      other prompts: 100.0% (2 of 2 prompts that served something)',
        '    acted on:',
        '      typed prompts: no data (0 relevant served memories); transcript unavailable: 1',
        '      relayed prompts: no data (0 relevant served memories); transcript unavailable: 1',
        '      task-notification prompts: no data (0 relevant served memories); transcript unavailable: 0',
        '      other prompts: no data (0 relevant served memories); transcript unavailable: 2',
        '    empty-handed serves:',
        '      typed prompts: 0.0% (0 of 1 prompts that served something)',
        '      relayed prompts: 50.0% (1 of 2 prompts that served something)',
        '      task-notification prompts: no data (0 prompts that served something)',
        '      other prompts: 0.0% (0 of 2 prompts that served something)',
        '    verdict calibration over every prompt:',
        '      typed prompts: "no relevant memory" right at confidence 0.7-0.8 0 of 11, 0.9-1.0 32 of 32; "memory likely exists" right at confidence 0.9-1.0 0 of 1',
        '      relayed prompts: "no relevant memory" right at confidence 0.6-0.7 0 of 1; "memory likely exists" right at confidence 0.7-0.8 1 of 1, 0.8-0.9 1 of 1',
        '      task-notification prompts: "no relevant memory" right at confidence 0.9-1.0 2 of 2; "memory likely exists" given to no prompt',
        '      other prompts: "no relevant memory" given to no prompt; "memory likely exists" right at confidence 0.8-0.9 2 of 2',
        '    verdict calibration over prompts with a dig:',
        '      typed prompts: "no relevant memory" right at confidence 0.7-0.8 0 of 11, 0.9-1.0 32 of 32; "memory likely exists" right at confidence 0.9-1.0 0 of 1',
        '      relayed prompts: "no relevant memory" right at confidence 0.6-0.7 0 of 1; "memory likely exists" right at confidence 0.7-0.8 1 of 1',
        '      task-notification prompts: "no relevant memory" right at confidence 0.9-1.0 1 of 1; "memory likely exists" given to no prompt with a dig',
        '      other prompts: "no relevant memory" given to no prompt with a dig; "memory likely exists" given to no prompt with a dig',
        '',
      ].join('\n'),
    ),
    output,
  );
});

test('a logged prompt without a kind is counted as other', async () => {
  const logs = await readRecallReportLogs(FIXTURE.dataDirectory, undefined);
  const early = logs.prompts.filter((prompt) => prompt.promptText.startsWith('EARLY'));
  assert.deepEqual(early.map((prompt) => prompt.promptKind), ['other', 'other']);
  const { output } = await REPORT_OVER_ALL_TIME;
  assert.ok(output.includes('      other prompts: 100.0% (2 of 2 prompts that served something)\n'), output);
});

async function removePromptKinds(dataDirectory: string, fileName: string): Promise<void> {
  const filePath = path.join(dataDirectory, fileName);
  const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
  const linesWithoutKinds = lines.map((line) => {
    const { promptKind: _promptKind, ...rest } = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify(rest);
  });
  await writeFile(filePath, `${linesWithoutKinds.join('\n')}\n`);
}

test('the report says when prompt kinds started being recorded', async () => {
  const { output } = await REPORT_OVER_ALL_TIME;
  const recordedSince =
    'Prompt kinds (typed, relayed, task-notification, other) recorded since 2026-10-01T09:01:00.000Z; a prompt logged without a kind counts as other\n';
  assert.ok(output.startsWith(`Jev recall report, all time\n${recordedSince}\n`), output);
  const laterWindow = await reportOn(FIXTURE, {
    backend: topicBackend(),
    flags: ['--since', '2026-10-01T11:00:00Z'],
  });
  assert.ok(laterWindow.output.includes(recordedSince), laterWindow.output);
  const dataDirectory = copyOfFixtureData(FIXTURE);
  await removePromptKinds(dataDirectory, RECALL_LEDGER_FILE_NAME);
  await removePromptKinds(dataDirectory, PROMPT_LOG_FILE_NAME);
  const beforeKinds = await reportOn(FIXTURE, { backend: topicBackend(), dataDirectory });
  assert.ok(
    beforeKinds.output.startsWith(
      'Jev recall report, all time\nNo logged prompt records its kind (typed, relayed, task-notification, other) yet, so every prompt counts as other\n',
    ),
    beforeKinds.output,
  );
  assert.ok(beforeKinds.output.includes('      other prompts: 25.5 per 100 prompts (13 of 51 prompts)\n'), beforeKinds.output);
});
