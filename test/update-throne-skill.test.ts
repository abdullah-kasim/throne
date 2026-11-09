import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { isPrintedBy, logLinesNamedIn, missingPhrases, readMarkdownSection, readSkill, readSkillSource, unwrap } from './skill-contract-test-helpers.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const FILES_THAT_PRINT_THE_LOG = ['scripts/update-throne.mjs', 'scripts/update-throne-checkout.mjs', 'scripts/update-throne-restarts.mjs'];
const LOG_LINE_OPENINGS = ['checkout:', 'question:', 'a run would refuse:', 'fork left alone:', 'REFUSING', 'FAILED:', 'report:', '===== '];
const STEP_WORK_THE_SKILL_MUST_NOT_DO = [
  'git merge',
  'git pull',
  'git fetch',
  'npm ci',
  'npm run build',
  'update-harness.mjs',
  'herdr-upgrade.mjs --pinned',
  'install-services',
  'systemctl',
  'launchctl',
  'throne restart-harnesses',
];
const NAMES_A_PUBLIC_SKILL_MUST_NOT_CARRY = ['import-from-public.sh', 'publish.sh', 'no-services'];

async function readScriptSource(): Promise<string> {
  const sources = await Promise.all(FILES_THAT_PRINT_THE_LOG.map((file) => readFile(resolve(REPOSITORY_ROOT, file), 'utf8')));
  return sources.join('\n');
}

test('the update-throne skill runs the one script and does no step by hand', async () => {
  const skill = await readSkill('update-throne');
  assert.deepEqual(
    missingPhrases(skill, [
      'user-invocable: true',
      '`scripts/update-throne.mjs`, run from the main throne checkout, does the whole update.',
      "The agent's job is to run it, ask the questions it prints, and read the log.",
      'node scripts/update-throne.mjs --check',
      'node scripts/update-throne.mjs [--bring-in-upstream] [--restart-ordered-by-lord "<the invoker\'s words, verbatim>"]',
    ]),
    [],
  );
  assert.deepEqual(STEP_WORK_THE_SKILL_MUST_NOT_DO.filter((work) => skill.includes(work)), []);
});

test('the update-throne skill asks each question and reads no answer as no', async () => {
  const ask = unwrap(readMarkdownSection(await readSkillSource('update-throne'), '### 2. Ask'));
  assert.deepEqual(
    missingPhrases(ask, [
      "Put each `question:` line to whoever invoked this skill, with the harness's question tool, unless the invoking order already answers it.",
      'With no one to answer, the answer is no.',
      'A yes adds `--bring-in-upstream` to step 3.',
      'A yes adds `--restart-ordered-by-lord` to step 3',
    ]),
    [],
  );
});

test("the update-throne skill passes the restart word only as the invoker's own words", async () => {
  const rule = unwrap(readMarkdownSection(await readSkillSource('update-throne'), "## The restart is the invoker's word only"));
  assert.deepEqual(
    missingPhrases(rule, [
      "pass their words verbatim. Never invent, paraphrase or shorten them; a relay from another agent is not the word.",
      'a run where herdr moves stops before the pull with nothing changed.',
    ]),
    [],
  );
});

test('the update-throne skill says the pane may end and where the relaunched agent reads the verdict', async () => {
  const section = unwrap(readMarkdownSection(await readSkillSource('update-throne'), '## The pane may end'));
  assert.deepEqual(
    missingPhrases(section, [
      'the pane running this skill can end during step 3.',
      '`~/tmp/herdr-upgrade.log` or `~/tmp/restart-harnesses.log`',
      'never relaunches anyone by hand.',
    ]),
    [],
  );
});

test('the update-throne skill names only log lines the script really prints', async () => {
  const logLines = logLinesNamedIn(await readSkillSource('update-throne'), LOG_LINE_OPENINGS);
  assert.deepEqual(
    missingPhrases(logLines.join('\n'), [
      'checkout: <private|public|fork> (<reason>)',
      'question: <text>',
      'a run would refuse: <why>',
      'fork left alone: <what>',
      'REFUSING — <why>',
      'FAILED: <why>',
      'report: throne <old> -> <new>',
      'report: <name> <version> unchanged',
      'report: restarted <what>',
      'report: not restarted <what> — <why>',
    ]),
    [],
  );
  const code = await readScriptSource();
  assert.deepEqual(logLines.filter((logLine) => !isPrintedBy(code, logLine)), []);
});

test('the update-throne skill and script carry nothing a public install cannot use', async () => {
  const shipped = `${await readSkillSource('update-throne')}\n${await readScriptSource()}`;
  assert.deepEqual(NAMES_A_PUBLIC_SKILL_MUST_NOT_CARRY.filter((name) => shipped.includes(name)), []);
});

test('the update-throne skill is recorded as shipped and is never held back from publishing', async () => {
  const manifest = await readFile(resolve(REPOSITORY_ROOT, '.claude/skill-dependencies.tsv'), 'utf8');
  assert.ok(manifest.split('\n').includes('update-throne\tshipped'));
  const publishList = await readFile(resolve(REPOSITORY_ROOT, 'scripts/publish-scrub-file.sh'), 'utf8');
  assert.ok(!publishList.includes('update-throne'));
});
