import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { shippedSkills } from './skill-contract-test-helpers.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILLS_DIRECTORY = path.join(REPO_ROOT, '.claude', 'skills');

function docInvokesSkill(doc: string, name: string): boolean {
  return new RegExp(`/${name}(?![\\w-])`).test(doc);
}

test('every shipped skill is documented in docs/THRONE_SKILLS.md', async () => {
  const doc = await readFile(path.join(REPO_ROOT, 'docs', 'THRONE_SKILLS.md'), 'utf8');
  const undocumented = [...shippedSkills(SKILLS_DIRECTORY)].filter((name) => !docInvokesSkill(doc, name));
  assert.deepEqual(undocumented, [], `skills missing from docs/THRONE_SKILLS.md: ${undocumented.join(', ')}`);
});

test('README links to docs/THRONE_SKILLS.md', async () => {
  const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\(docs\/THRONE_SKILLS\.md\)/);
});
