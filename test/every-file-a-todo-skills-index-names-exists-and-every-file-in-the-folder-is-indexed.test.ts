import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { readMarkdownSection, readSkillSource } from './skill-contract-test-helpers.ts';

const SKILLS_DIRECTORY = resolve(import.meta.dirname, '..', '.claude/skills');
const INDEXED_SKILLS = ['execute-todos', 'write-todos'];

function indexedFileNames(section: string): string[] {
  return [...section.matchAll(/^- `([^`]+)` — read /gm)].map((match) => match[1]);
}

for (const skill of INDEXED_SKILLS) {
  test(`every file the ${skill} index names exists and every file in its folder is named by the index`, async () => {
    const section = readMarkdownSection(await readSkillSource(skill), '## Supporting files');
    assert.notEqual(section, '', `${skill}/SKILL.md has no "## Supporting files" section`);
    const indexed = indexedFileNames(section).sort();
    const present = readdirSync(resolve(SKILLS_DIRECTORY, skill))
      .filter((name) => name !== 'SKILL.md')
      .sort();
    assert.deepEqual(
      indexed.filter((name) => !present.includes(name)),
      [],
      'index names files missing from the folder',
    );
    assert.deepEqual(
      present.filter((name) => !indexed.includes(name)),
      [],
      'folder holds files the index does not name',
    );
  });
}
