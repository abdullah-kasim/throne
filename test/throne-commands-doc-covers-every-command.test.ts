import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { publicCommandNames } from '../src/shared-policy/command-registry.ts';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('every public command is documented in docs/THRONE_COMMANDS.md', async () => {
  const doc = await readFile(path.join(REPO_ROOT, 'docs', 'THRONE_COMMANDS.md'), 'utf8');
  const missing = publicCommandNames().filter((name) => !doc.includes(`| \`${name}\` |`));
  assert.deepEqual(missing, [], `undocumented public commands: ${missing.join(', ')}`);
});

test('README links to docs/THRONE_COMMANDS.md', async () => {
  const readme = await readFile(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\(docs\/THRONE_COMMANDS\.md\)/);
});
