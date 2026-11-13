import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  isPrintedBy,
  logLinesNamedIn,
  missingPhrases,
  readMarkdownSection,
  readSkill,
  readSkillSource,
  unwrap,
} from './skill-contract-test-helpers.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const FILES_THAT_WRITE_THE_APPLY_LOG = [
  'scripts/herdr-upgrade.mjs',
  'scripts/herdr-repair-identities.mjs',
  'scripts/land-pin-commit.mjs',
  'src/herdr-update/herdr-upgrade-restart.ts',
  'src/herdr-update/herdr-upgrade-resume.ts',
  'src/herdr-update/herdr-version-agreement.ts',
];
const DRY_RUN_ONLY_CODE = /if \(DRY\) \{[\s\S]*?\n  \}\n|if \(DRY\) return .*\n/g;
const LOG_LINE_OPENINGS = ['phase', 'repair:', 'restarted server', '=====', '--- ', 'REFUSING', 'FAILED:', 'throne cli herdr'];

async function readUpdateHerdrSection(heading: string): Promise<string> {
  const section = readMarkdownSection(await readSkillSource('update-herdr'), heading);
  assert.notEqual(section, '', `update-herdr has no "${heading}" section`);
  return unwrap(section);
}

async function readCodeAnApplyRuns(): Promise<string> {
  const sources = await Promise.all(
    FILES_THAT_WRITE_THE_APPLY_LOG.map((file) => readFile(resolve(REPOSITORY_ROOT, file), 'utf8')),
  );
  return sources.join('\n').replace(DRY_RUN_ONLY_CODE, '');
}

test('the update-herdr skill checks, rehearses and applies through the one upgrade script', async () => {
  assert.deepEqual(
    missingPhrases(await readSkill('update-herdr'), [
      'user-invocable: true',
      'Use `scripts/herdr-upgrade.mjs`, run from the live throne root, for every step.',
      'Do not reproduce its rehearsal, hash check, pin moves, pin commit, unit rendering, restart, resume or identity repair by hand.',
      "The agent's job is to run it and read the log.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 1. Check'), [
      'bun scripts/herdr-upgrade.mjs --check',
      'Mutates nothing',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 2. Rehearse'), [
      'bun scripts/herdr-upgrade.mjs <tag> --dry-run',
      'it moves nothing',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 3. Apply'), [
      'bun scripts/herdr-upgrade.mjs <tag> --yes --restart-ordered-by-lord "<the Lord\'s words, verbatim>"',
    ]),
    [],
  );
});

test('the update-herdr skill says what to read in the upgrade log at every step', async () => {
  assert.deepEqual(
    missingPhrases(await readSkill('update-herdr'), [
      'Every line the script prints is also appended to `~/tmp/herdr-upgrade.log`',
      'read the section under the latest header.',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 1. Check'), [
      "Read in the log: the pinned tag, the installed tags, the live server's version and protocol, the versions line, and the latest release.",
      'When the latest release is the pinned tag and a service restart is ordered, carry on with that tag',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 2. Rehearse'), [
      'Read in the log:',
      'the hash verification against the release metadata;',
      'the result of the read-only command sweep;',
      'the protocol the new binary reported itself, set beside the protocol on the `live throne server:` line at the top of the section;',
      'the phase 7 and phase 8 plan for this platform;',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 3. Apply'), [
      'An apply writes two sections to the log.',
      'The last `phase 7:` line is the pin commit line.',
      'The detached unit appends the second section.',
      'then the versions line that closes the section:',
    ]),
    [],
  );
});

test('the update skill names only log lines an apply really prints', async () => {
  const skill = await readSkillSource('update-herdr');
  const logLines = [
    ...logLinesNamedIn(readMarkdownSection(skill, '### 3. Apply'), LOG_LINE_OPENINGS),
    ...logLinesNamedIn(readMarkdownSection(skill, '## What the restart does to agents'), LOG_LINE_OPENINGS),
  ];
  assert.deepEqual(
    missingPhrases(logLines.join('\n'), [
      'phase 7:',
      'phases 8-10: restart, resume and identity repair, detached',
      'restarted server runs <version> protocol <protocol>',
      'repair: <outcome> "<name>" — <detail>',
      '===== done <date> =====',
      'throne cli herdr <version>, bin/herdr <version>, running service <version>',
    ]),
    [],
  );
  const code = await readCodeAnApplyRuns();
  assert.deepEqual(
    logLines.filter((logLine) => !isPrintedBy(code, logLine)),
    [],
  );
});

test('update-harnesses has the agent run check and never read the pin by hand', async () => {
  const preconditions = unwrap(readMarkdownSection(await readSkillSource('update-harnesses'), '## Preconditions'));
  assert.deepEqual(
    missingPhrases(preconditions, [
      '2. Run `check` first',
      'This pair — pinned and vendored — is the harness the court actually runs.',
    ]),
    [],
  );
  assert.ok(!preconditions.includes('Read `vendor-pins.json`'));
});

test("the update-herdr skill passes the Lord's word only when he ordered the restart", async () => {
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection("## The restart is the Lord's word only"), [
      "Pass `--restart-ordered-by-lord` only when the queue row's RULINGS or the Lord's own message order the herdr restart for this update, and pass his words verbatim.",
      'Never invent, paraphrase or shorten them; a relay from another agent is not his word.',
      'Without them, stop after the rehearse step and report it.',
    ]),
    [],
  );
});

test('the update-herdr skill says a herdr restart ends every agent and where the monitor reads the result', async () => {
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('## What the restart does to agents'), [
      'A herdr restart ends every pane process on Linux and on macOS',
      'The pane that ran apply dies with the rest',
      'the monitoring agent is relaunched too: it reads the result in the log afterwards',
    ]),
    [],
  );
});

test('the update-herdr skill no longer stops at a pinned latest release when a restart is ordered', async () => {
  const skill = await readSkill('update-herdr');
  assert.ok(!skill.includes('When the latest release is the pinned tag, report that and stop.'));
  assert.ok(!skill.includes('## Panes on macOS'));
});

test('the update-herdr skill catches a machine up to the pin through the one upgrade script', async () => {
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('## Catch up to the pinned tag'), [
      'bun scripts/herdr-upgrade.mjs --pinned --dry-run',
      'bun scripts/herdr-upgrade.mjs --pinned --restart-ordered-by-lord "<the Lord\'s words, verbatim>"',
      'The target is the tag `src/herdr/herdr-client.ts` pins, so this takes no tag.',
      'There is no rehearsal, no pin move, no pin commit and no build',
      'Nothing restarts and no word is needed.',
      "a real run needs the Lord's word and refuses without it, before changing anything.",
      'The snapshot uses the binary of the version the running server reports',
    ]),
    [],
  );
});

test('the update-herdr skill names only log lines the pinned path really prints', async () => {
  const section = readMarkdownSection(await readSkillSource('update-herdr'), '## Catch up to the pinned tag');
  const code = await readFile(resolve(REPOSITORY_ROOT, 'scripts/herdr-upgrade.mjs'), 'utf8');
  assert.deepEqual(
    ['herdr is at its pin <tag>, nothing to do', 'herdr is not at its pin <tag>:'].filter(
      (logLine) => !section.includes(logLine) || !isPrintedBy(code.replaceAll('${TAG}', '<tag>'), logLine),
    ),
    [],
  );
});

test('the update-herdr skill points at the runbook for the traps', async () => {
  assert.deepEqual(
    missingPhrases(await readSkill('update-herdr'), [
      '`src/herdr-update/RUNBOOK.md` under "The five traps this replaces"',
      'this skill does not restate them.',
    ]),
    [],
  );
});

test('update-harnesses sends a herdr update to update-herdr', async () => {
  const preconditions = unwrap(readMarkdownSection(await readSkillSource('update-harnesses'), '## Preconditions'));
  assert.deepEqual(
    missingPhrases(preconditions, [
      '3. Never update or restart Herdr from this skill. A herdr update goes through `/update-herdr`.',
    ]),
    [],
  );
});

test('the update-herdr skill says a macOS apply reloads the herdr agent and that FAILED means the update did not take', async () => {
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 3. Apply'), [
      'it never bootstraps before launchd confirms the bootout.',
      'A line starting `FAILED:` in the restart section means the update did not take',
      'the court is down until someone runs the `launchctl bootstrap` command it names.',
    ]),
    [],
  );
});
