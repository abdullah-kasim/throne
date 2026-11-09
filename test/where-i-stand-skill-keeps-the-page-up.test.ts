import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { missingPhrases, readMarkdownSection, unwrap } from './skill-contract-test-helpers.ts';

const SKILL_FILE = resolve(import.meta.dirname, '..', '.claude/skills/where-i-stand/SKILL.md');
const SERVING_STEP_HEADING = '### 5. Keep the tailnet page up';

async function readSkillSection(heading: string): Promise<string> {
  const section = readMarkdownSection(await readFile(SKILL_FILE, 'utf8'), heading);
  assert.notEqual(section, '', `the where-i-stand skill has the section "${heading}"`);
  return unwrap(section);
}

test('the where-i-stand skill serves the page from the backend, on the tailnet only', async () => {
  const servingStep = await readSkillSection(SERVING_STEP_HEADING);
  assert.deepEqual(
    missingPhrases(servingStep, [
      'The throne backend serves it on 127.0.0.1 only',
      'on the tailnet only, never through funnel',
      '`https://<host>/throne/where-i-stand/`',
      'The old address `https://<host>/where-i-stand/` still works',
      'so the page always shows the live files. Nothing is copied.',
    ]),
    [],
  );
  assert.ok(!servingStep.includes('tailscale funnel'), 'no step runs a funnel');
  assert.ok(!servingStep.includes('page_server'), 'the page server is gone');
  assert.ok(!servingStep.includes('tailnet-preview'), 'the static share is gone');
});

test('the where-i-stand skill checks the page by reading the api and the tailnet path, not by a bare status', async () => {
  const servingStep = await readSkillSection(SERVING_STEP_HEADING);
  assert.deepEqual(
    missingPhrases(servingStep, [
      `curl -s "$tailnet_address/throne/api/where-i-stand/page" | python3 -c 'import json,sys; json.load(sys.stdin)["markdown"]'`,
      "tailscale serve status | grep -F ' /throne '",
      'a bare `200` is fooled by any app published at `/`',
    ]),
    [],
  );
  assert.ok(!servingStep.includes('%{http_code}'), 'no check trusts a status code');
});

test('the where-i-stand skill sends a page that is down to the backend, and reports a path held by something else', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection(SERVING_STEP_HEADING), [
      'the remedy is the backend, not a server of your own',
      'Report that path and its holder, and leave it.',
      'Never take a path over with `tailscale serve` by hand',
      'When the data file is missing, run the reader once with `--refresh` (step 2), which writes it.',
    ]),
    [],
  );
});

test('the where-i-stand skill says the api saves from the page, journaled as the Lord, and an agent never does', async () => {
  assert.deepEqual(
    missingPhrases(await readSkillSection(SERVING_STEP_HEADING), [
      '`POST /api/where-i-stand/save` runs the same code as `throne where-i-stand save`',
      'journals the edit with the writer `Lord`',
      'It refuses any save that would change the page outside `## Epics`.',
      'Only the API saves from the page; an agent never runs `throne where-i-stand save`.',
    ]),
    [],
  );
});

test("the where-i-stand skill says the Lord's page edits are for epics only", async () => {
  const skill = unwrap(await readFile(SKILL_FILE, 'utf8'));
  assert.ok(!skill.includes('only agents write'), 'no sentence says only agents write the page');
  assert.ok(!skill.includes('edits or removes an entry'), 'no line says the Lord edits an entry where he reads it');
  assert.deepEqual(
    missingPhrases(skill, ["The Lord's own page edits are for epics only", 'every other tab is read-only']),
    [],
  );
  assert.deepEqual(
    missingPhrases(await readSkillSection('## Who writes, and when'), [
      '| Lord | adds, edits or removes an epic on the page |',
      'a save whose epic changed since he loaded the page is refused',
      'a save that would change the page outside `## Epics` is refused',
    ]),
    [],
  );
});
