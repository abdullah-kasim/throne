import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { StartInTabDeps } from '../src/herdr/herdr-create.contracts.ts';

type LaunchEffect = (launchScriptPath: string) => Promise<void>;

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(
    () => true,
    () => false,
  );
}

export async function waitForPath(candidate: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await pathExists(candidate))) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${candidate}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function waitForMissingPath(
  candidate: string,
  timeoutMs: number = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await pathExists(candidate)) {
    assert.ok(
      Date.now() < deadline,
      `timed out waiting to remove ${candidate}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function settingsPathFromLaunchScript(
  launchScriptPath: string,
): Promise<string> {
  const launchText = await fs.readFile(launchScriptPath, 'utf8');
  const settingsPath = launchText.match(/--settings' '([^']+)'/)?.[1];
  assert.ok(settingsPath, 'launch script passes the staged settings path');
  return settingsPath;
}

export function claudeyAllLaunchDeps(
  paneId: string,
  launch: LaunchEffect,
): StartInTabDeps {
  return {
    runHerdr: async (args) => {
      if (args[0] === 'pane' && args[1] === 'run') {
        const launchScriptPath = args[4];
        assert.ok(launchScriptPath, 'pane run names the launch script');
        await launch(launchScriptPath);
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'agent' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                {
                  agent: 'claude',
                  agent_status: 'idle',
                  cwd: '/work',
                  focused: false,
                  pane_id: paneId,
                  tab_id: 'wB:t-claudey-all-fixture',
                  terminal_id: 'term-claudey-all-fixture',
                },
              ],
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'agent' && args[1] === 'rename') {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected herdr call: ${args.join(' ')}`);
    },
    now: Date.now,
    sleep: async () => {},
  };
}

export async function removeStagedLaunchArtifacts(
  ...artifactPaths: string[]
): Promise<void> {
  await Promise.all(
    artifactPaths
      .filter((artifactPath) => artifactPath !== '')
      .map((artifactPath) =>
        fs.rm(path.dirname(artifactPath), { recursive: true, force: true }),
      ),
  );
}
