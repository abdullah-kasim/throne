import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  missingPhrases,
  readMarkdownSection,
  readSkill,
  readSkillSource,
  unwrap,
} from './skill-contract-test-helpers.ts';

async function readUpdateHerdrSection(heading: string): Promise<string> {
  const section = readMarkdownSection(await readSkillSource('update-herdr'), heading);
  assert.notEqual(section, '', `update-herdr has no "${heading}" section`);
  return unwrap(section);
}

test('the update-herdr skill checks, rehearses and applies through the one upgrade script', async () => {
  assert.deepEqual(
    missingPhrases(await readSkill('update-herdr'), [
      'user-invocable: true',
      'Use `scripts/herdr-upgrade.mjs`, run from the live throne root, for every step.',
      'Do not reproduce its rehearsal, hash check, pin moves, unit rendering, restart or identity repair by hand.',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 1. Check'), [
      'node scripts/herdr-upgrade.mjs --check',
      'Mutates nothing',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 2. Rehearse'), [
      'node scripts/herdr-upgrade.mjs <tag> --dry-run',
      'it moves nothing',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 3. Apply'), [
      'node scripts/herdr-upgrade.mjs <tag> --yes --restart-ordered-by-lord "<the Lord\'s words, verbatim>"',
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
      "Read in the log: the pinned tag, the installed tags, the live server's version and protocol, and the latest release.",
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 2. Rehearse'), [
      'Read in the log:',
      'the hash verification against the release metadata;',
      'the result of the read-only command sweep;',
      'the protocol the new binary reported itself, and whether it differs from the pinned one;',
      'the phase 7 and phase 8 plan for this platform;',
    ]),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('### 3. Apply'), [
      'Read in the log: every `phase N:` line through phase 10, the detached restart section, the server status after the restart (version and protocol), and the roster after the identity repair.',
    ]),
    [],
  );
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

test('the update-herdr skill says a herdr reload on a mac drops every pane', async () => {
  assert.deepEqual(
    missingPhrases(await readUpdateHerdrSection('## Panes on macOS'), [
      'That was observed on Linux under systemd.',
      'On macOS a herdr reload drops every herdr pane',
    ]),
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
