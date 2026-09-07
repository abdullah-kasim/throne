// Requirement: every spawned agent is told where its durable memory lives —
// the resolution taken at spawn is written into identity.md and rendered
// into the opening prompt for every role; an agent spawned without a
// resolution is told to resolve it itself, never handed a fabricated path.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  MEMORY_DIRECTORY_LINE_PREFIX,
  composeOpeningPrompt,
  writeIdentity,
} from './identity-data.service.ts';
import type { MemoryResolution } from '../memory-dir/memory-dir-resolver.ts';

const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const MEMORY: MemoryResolution = {
  mode: 'external',
  path: '/home/op/.memories/-home-op-repos-app',
  repoRoot: '/home/op/repos/app',
  evidence: '/home/op/.local/bin/memory-dir',
};

for (const role of ['Alpha', 'Shadow', 'Stager'] as const) {
  test(`a ${role} spawned with a memory resolution is told the path, mode and evidence in its opening prompt`, () => {
    const prompt = composeOpeningPrompt(`${role.toLowerCase()}-memory-test`, {
      supervisor: 'Regent',
      escalation: 'Regent',
      role,
      memory: MEMORY,
    });
    assert.match(prompt, /`\/home\/op\/\.memories\/-home-op-repos-app`/);
    assert.match(prompt, /mode external/);
    assert.match(prompt, /\/home\/op\/\.local\/bin\/memory-dir/);
    assert.doesNotMatch(prompt, /agent_docs\/MEMORY/);
  });
}

test('an Alpha standing instruction points learnings at the identity memory directory, not an in-tree path', () => {
  const prompt = composeOpeningPrompt('alpha-memory-test', {
    supervisor: 'Regent',
    escalation: 'Regent',
    role: 'Alpha',
    memory: MEMORY,
  });
  assert.match(prompt, /learnings go to the memory directory named in your identity/);
});

test('an agent without a resolution is told to run throne memory-dir itself', () => {
  const prompt = composeOpeningPrompt('shadow-memory-test', {
    supervisor: 'alpha-x',
    escalation: 'Regent',
    role: 'Shadow',
  });
  assert.match(prompt, /was not resolved at spawn/);
  assert.match(prompt, /throne memory-dir --json/);
  assert.doesNotMatch(prompt, /\.throne\/memories/);
});

test('identity.md records the memory directory as a durable line', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'throne-identity-memory-'));
  scratch.push(dataDir);
  await writeIdentity('alpha-memory-test', {
    supervisor: 'Regent',
    escalation: 'Regent',
    role: 'Alpha',
    memory: MEMORY,
  }, dataDir);
  const body = await readFile(join(dataDir, 'alpha-memory-test', 'identity.md'), 'utf8');
  assert.ok(body.includes(`${MEMORY_DIRECTORY_LINE_PREFIX}${MEMORY.path} (mode external)`), body);
});
