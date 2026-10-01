import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { harnessProvenance, HARNESS_PROVENANCE_STATES } from './harness-provenance.ts';
import type { HerdrForegroundProcess } from './herdr-inventory.service.ts';

const SESSION_ID = '0d3c2a1e-5b6f-4c7d-8e9f-a0b1c2d3e4f5';

async function vendoredInstall(): Promise<string> {
  const nodeModules = path.join(await mkdtemp(path.join(os.tmpdir(), 'throne-vendor-')), 'node_modules');
  const targets = {
    claude: '../@anthropic-ai/claude-code/bin/claude.exe',
    codex: '../@openai/codex/bin/codex.js',
  };
  await mkdir(path.join(nodeModules, '.bin'), { recursive: true });
  for (const [name, target] of Object.entries(targets)) {
    const resolved = path.resolve(nodeModules, '.bin', target);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, '');
    await symlink(target, path.join(nodeModules, '.bin', name));
  }
  return path.join(nodeModules, '.bin');
}

function provenanceOf(processes: HerdrForegroundProcess[], vendoredHarnessBinaryDirectory: string) {
  return harnessProvenance('pane-1', {
    getPaneProcessInfo: async (paneId) => ({ paneId, foregroundProcesses: processes }),
    vendoredHarnessBinaryDirectory,
  });
}

const mcpHelper: HerdrForegroundProcess = { name: 'node', argv: ['mcp-context-work'], pid: 9 };

test('a pane whose harness runs through the vendored link is recognised as pinned', async () => {
  const vendored = await vendoredInstall();
  const claude = await provenanceOf([
    mcpHelper,
    { name: 'claude.exe', argv: [path.join(vendored, 'claude'), '--resume', SESSION_ID], pid: 10 },
  ], vendored);
  const codex = await provenanceOf([
    { name: 'node', argv: ['node', path.join(vendored, 'codex'), 'resume', SESSION_ID], pid: 11 },
    mcpHelper,
  ], vendored);

  assert.equal(claude.state, HARNESS_PROVENANCE_STATES.PINNED);
  assert.equal(claude.executablePath, path.join(vendored, 'claude'));
  assert.equal(codex.state, HARNESS_PROVENANCE_STATES.PINNED);
  assert.equal(codex.executablePath, path.join(vendored, 'codex'));
});

test('a harness started by bare name is treated as foreign', async () => {
  const vendored = await vendoredInstall();
  const provenance = await provenanceOf([
    { name: 'claude', argv: ['claude', '--resume', SESSION_ID], pid: 12 },
    mcpHelper,
  ], vendored);

  assert.deepEqual(provenance, {
    state: HARNESS_PROVENANCE_STATES.FOREIGN,
    executablePath: 'claude',
    argv: ['claude', '--resume', SESSION_ID],
  });
});
