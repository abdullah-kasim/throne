import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startInTab } from './herdr-launch.ts';
import { PinnedHarnessBinaryMissingError } from './herdr-launch-command.ts';
import type { StartInTabDeps, StartOptions } from './herdr-create.contracts.ts';

function vendoredBinaryDirectory(executables: readonly string[]): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'throne-vendored-bin-'));
  for (const executable of executables) {
    const binary = path.join(directory, executable);
    writeFileSync(binary, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(binary, 0o755);
  }
  return directory;
}

function fakeDeps(
  calls: string[][],
  vendoredHarnessBinaryDirectory: string,
  detectedKind = 'claude',
): StartInTabDeps {
  const runHerdr = (async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'agent' && args[1] === 'list') {
      return {
        stdout: JSON.stringify({
          result: {
            agents: [
              { agent: detectedKind, terminal_id: 'term-1', pane_id: 'pane-1', name: 'agent-name' },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }) as StartInTabDeps['runHerdr'];
  return { runHerdr, now: () => 0, sleep: async () => undefined, vendoredHarnessBinaryDirectory };
}

function typedLaunchLine(calls: string[][]): string {
  const sendTextCall = calls.find((c) => c[0] === 'pane' && c[1] === 'send-text');
  assert.ok(sendTextCall, 'the launch was issued via pane send-text, not pane run');
  return sendTextCall![3]!;
}

function launchScriptText(typedLine: string): string {
  const scriptPath = typedLine.match(/^ bash '([^']+)'$/)?.[1];
  assert.ok(scriptPath, `typed launch line "${typedLine}" names a quoted script path`);
  return readFileSync(scriptPath!, 'utf8');
}

test('the launch command is typed with a leading space so bash ignorespace history control skips it', async () => {
  const calls: string[][] = [];
  const opts: StartOptions = { argv: ['claude'] };

  await startInTab('agent-name', 'pane-1', opts, fakeDeps(calls, vendoredBinaryDirectory(['claude'])));

  const typedLine = typedLaunchLine(calls);
  assert.ok(
    typedLine.startsWith(' bash '),
    `typed launch line "${typedLine}" must start with a single leading space to suppress history recording`,
  );
  assert.ok(calls.find((c) => c[0] === 'pane' && c[1] === 'send-keys'), 'Enter was sent after the typed launch line');
  assert.equal(calls.find((c) => c[0] === 'pane' && c[1] === 'run'), undefined, 'pane run must not be used for launching');
});

test('the launch script exports CLAUDE_BIN as the vendored binary before the harness is executed, so the pane shell cannot supply its own', async () => {
  const calls: string[][] = [];
  const directory = vendoredBinaryDirectory(['claude']);
  await startInTab('agent-name', 'pane-1', { argv: ['claude', '--model', 'opus'] }, fakeDeps(calls, directory));
  const script = launchScriptText(typedLaunchLine(calls));
  assert.match(script, new RegExp(`^export CLAUDE_BIN='${path.join(directory, 'claude')}'$`, 'm'));
  assert.ok(script.indexOf('export CLAUDE_BIN=') < script.indexOf('exec '), 'the pin is exported before the harness is executed');
});

test('a codex launch pins CODEX_BIN the same way', async () => {
  const calls: string[][] = [];
  const directory = vendoredBinaryDirectory(['codex']);
  await startInTab('agent-name', 'pane-1', { argv: ['codexy', '-m', 'gpt-5.6-sol'] }, fakeDeps(calls, directory, 'codex'));
  const script = launchScriptText(typedLaunchLine(calls));
  assert.match(script, new RegExp(`^export CODEX_BIN='${path.join(directory, 'codex')}'$`, 'm'));
});

test('a missing vendored binary refuses the launch loudly before anything is typed into the pane', async () => {
  const calls: string[][] = [];
  const emptyDirectory = mkdtempSync(path.join(os.tmpdir(), 'throne-no-vendored-bin-'));
  mkdirSync(emptyDirectory, { recursive: true });
  await assert.rejects(
    startInTab('agent-name', 'pane-1', { argv: ['claude'] }, fakeDeps(calls, emptyDirectory)),
    (error: unknown) =>
      error instanceof PinnedHarnessBinaryMissingError &&
      error.binaryPath === path.join(emptyDirectory, 'claude') &&
      /vendor-pins\.json/.test(error.message),
  );
  assert.deepEqual(calls, []);
});
