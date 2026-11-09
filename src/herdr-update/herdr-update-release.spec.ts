import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY,
  HERDR_INSTALL_OUTCOMES,
  installRehearsedRelease,
  type HerdrUpdateProcessBoundary,
} from './herdr-update-release.ts';

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseBoundary(artifact: Buffer, requests: string[]): HerdrUpdateProcessBoundary {
  return {
    ...DEFAULT_HERDR_UPDATE_PROCESS_BOUNDARY,
    ghApi: async (endpoint) => {
      requests.push(endpoint);
      const name = `herdr-${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
      return JSON.stringify({
        assets: [{ name, digest: `sha256:${sha256Of(artifact)}`, browser_download_url: 'https://releases.invalid/herdr' }],
      });
    },
    download: async () => artifact,
  };
}

test('an apply of the running tag leaves the running binary in place', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-install-'));
  const runningBinary = path.join(scratch, 'herdr');
  await copyFile('/usr/bin/sleep', runningBinary);
  await chmod(runningBinary, 0o755);
  const running = spawn(runningBinary, ['30'], { stdio: 'ignore' });
  try {
    const before = await stat(runningBinary);
    const bytes = await readFile(runningBinary);
    const requests: string[] = [];
    const outcome = await installRehearsedRelease('v0.9.5', sha256Of(bytes), runningBinary, releaseBoundary(bytes, requests));
    assert.equal(outcome, HERDR_INSTALL_OUTCOMES.LEFT_IN_PLACE);
    assert.deepEqual(requests, []);
    const after = await stat(runningBinary);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    running.kill('SIGKILL');
    await rm(scratch, { recursive: true, force: true });
  }
});

test('an apply of a new tag installs the rehearsed artifact and nothing else', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-upgrade-install-'));
  try {
    const destination = path.join(scratch, 'v0.9.6', 'herdr');
    const artifact = Buffer.from('the rehearsed release');
    const requests: string[] = [];
    const boundary = releaseBoundary(artifact, requests);
    await assert.rejects(
      installRehearsedRelease('v0.9.6', 'a'.repeat(64), destination, boundary),
      /is not the rehearsed/,
    );
    const outcome = await installRehearsedRelease('v0.9.6', sha256Of(artifact), destination, boundary);
    assert.equal(outcome, HERDR_INSTALL_OUTCOMES.INSTALLED);
    assert.deepEqual(await readFile(destination), artifact);
    assert.equal((await stat(destination)).mode & 0o777, 0o755);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
