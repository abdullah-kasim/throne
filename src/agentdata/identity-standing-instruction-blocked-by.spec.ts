// Requirement: the Alpha and Shadow standing identity instructions document
// the `{"blocked":true}` + `__BLOCKED_BY_<name>__` convention so a freshly
// spawned agent can use it without having read any planning bundle.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { composeOpeningPrompt, readOpeningPrompt, writeOpeningPrompt } from './identity-data.service.ts';

const scratchDirectories: string[] = [];
function scratchDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'throne-identity-blocked-by-'));
  scratchDirectories.push(directory);
  return directory;
}
after(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

for (const role of ['Alpha', 'Shadow'] as const) {
  test(`a freshly spawned ${role}'s generated opening prompt documents the {"blocked":true} + __BLOCKED_BY_<name>__ convention`, async () => {
    const dataDir = scratchDataDir();
    const prompt = composeOpeningPrompt(`${role.toLowerCase()}-test`, {
      supervisor: 'Regent',
      escalation: 'Regent',
      role,
    });
    await writeOpeningPrompt(`${role.toLowerCase()}-test`, prompt, dataDir);

    const rendered = await readOpeningPrompt(`${role.toLowerCase()}-test`, dataDir);

    assert.ok(rendered, 'the opening prompt was written');
    assert.match(rendered!, /\{"blocked":true\}/);
    assert.match(rendered!, /__BLOCKED_BY_<name>__/);
  });
}
