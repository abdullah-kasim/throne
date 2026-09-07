// Requirement: docs/CONFIG.md names every config.user.ts key the loader
// accepts — top-level persona fields, the ntfy fields, every steering field,
// every identity field, the custom-preset pool names and the tierTitles keys —
// so a new field cannot ship undocumented, and README points at the document.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  IDENTITY_SECTION_FIELDS,
  PERSONA_SECTION_FIELDS,
  STEERING_SECTION_FIELDS,
} from '../src/user-config-loader.ts';
import { NTFY_FIELDS } from '../src/shared-policy/ntfy-user-config.ts';
import { PLAN_PRESET_NAMES } from '../src/steering-user-config.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('docs/CONFIG.md documents every key the loader knows', async () => {
  const doc = await readFile(path.join(REPO_ROOT, 'docs', 'CONFIG.md'), 'utf8');
  const expected = [
    ...PERSONA_SECTION_FIELDS,
    ...NTFY_FIELDS,
    ...STEERING_SECTION_FIELDS,
    ...IDENTITY_SECTION_FIELDS,
    'alpha', 'shadow', 'shadowSlice99',
    'regent',
    ...PLAN_PRESET_NAMES,
  ];
  const missing = expected.filter((key) => !doc.includes(`\`${key}\``) && !doc.includes(`'${key}'`) && !doc.includes(`${key}:`));
  assert.deepEqual(missing, [], `undocumented config.user.ts keys: ${missing.join(', ')}`);
});

test('README links to docs/CONFIG.md', async () => {
  const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\(docs\/CONFIG\.md\)/);
});
