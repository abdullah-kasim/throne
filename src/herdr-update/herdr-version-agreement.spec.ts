import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { herdrIsAtPin, herdrVersionAgreement, onlyBinHerdrMissesThePin, readHerdrVersions, type HerdrVersions } from './herdr-version-agreement.ts';

function fakeHerdr(version: string, serviceStatus: string): string {
  return `#!/bin/sh
case "$1" in
  --version) echo "herdr ${version}" ;;
  --session) echo '${serviceStatus}' ;;
esac
`;
}

async function versionsFrom(cli: string, shim: string, serviceStatus: string): Promise<HerdrVersions> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'herdr-version-agreement-'));
  try {
    const clientPath = path.join(scratch, 'client');
    const shimPath = path.join(scratch, 'shim');
    await writeFile(clientPath, fakeHerdr(cli, serviceStatus));
    await writeFile(shimPath, fakeHerdr(shim, serviceStatus));
    await chmod(clientPath, 0o755);
    await chmod(shimPath, 0o755);
    return await readHerdrVersions(shimPath, clientPath, 'throne');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('a throne cli herdr that differs from the running service fails naming both versions', async () => {
  const line = herdrVersionAgreement(await versionsFrom('0.9.6', '0.9.5', '{"running":true,"version":"0.9.5"}'));
  assert.match(line, /^FAILED: /);
  assert.match(line, /throne cli herdr 0\.9\.6/);
  assert.match(line, /running service 0\.9\.5/);
});

test('a bin/herdr shim that differs from the running service fails naming both versions', async () => {
  const line = herdrVersionAgreement(await versionsFrom('0.9.5', '0.9.6', '{"running":true,"version":"0.9.5"}'));
  assert.match(line, /^FAILED: /);
  assert.match(line, /bin\/herdr 0\.9\.6/);
  assert.match(line, /running service 0\.9\.5/);
});

test('matching versions are reported side by side', async () => {
  assert.equal(
    herdrVersionAgreement(await versionsFrom('0.9.5', '0.9.5', '{"running":true,"version":"0.9.5"}')),
    'throne cli herdr 0.9.5, bin/herdr 0.9.5, running service 0.9.5',
  );
});

test('a service that is not running fails the agreement', async () => {
  const line = herdrVersionAgreement(await versionsFrom('0.9.5', '0.9.5', '{"running":false,"version":null}'));
  assert.match(line, /^FAILED: /);
  assert.match(line, /running service not running/);
});

test('a client that cannot be run fails the agreement', async () => {
  const line = herdrVersionAgreement(await readHerdrVersions('/nonexistent/shim', '/nonexistent/client', 'throne'));
  assert.match(line, /^FAILED: .*throne cli herdr unreadable/);
});

test('a disagreement between the CLI and the running service counts as not at the pin', async () => {
  const newClientOldServer = await versionsFrom('0.9.6', '0.9.6', '{"running":true,"version":"0.9.5"}');
  assert.equal(herdrIsAtPin(newClientOldServer, 'v0.9.6'), false);
  const oldClientNewServer = await versionsFrom('0.9.5', '0.9.6', '{"running":true,"version":"0.9.6"}');
  assert.equal(herdrIsAtPin(oldClientNewServer, 'v0.9.6'), false);
});

test('versions that agree on another release are not at the pin', async () => {
  assert.equal(herdrIsAtPin(await versionsFrom('0.9.5', '0.9.5', '{"running":true,"version":"0.9.5"}'), 'v0.9.6'), false);
});

test('all three reporting the pinned release are at the pin', async () => {
  assert.equal(herdrIsAtPin(await versionsFrom('0.9.6', '0.9.6', '{"running":true,"version":"0.9.6"}'), 'v0.9.6'), true);
});

test('bin/herdr alone off the pin is what a restart cannot fix', async () => {
  const onlyTheShim = await versionsFrom('0.9.6', '0.9.7', '{"running":true,"version":"0.9.6"}');
  assert.equal(onlyBinHerdrMissesThePin(onlyTheShim, 'v0.9.6'), true);
});

test('a client or service off the pin is what a restart can fix', async () => {
  assert.equal(onlyBinHerdrMissesThePin(await versionsFrom('0.9.6', '0.9.7', '{"running":true,"version":"0.9.5"}'), 'v0.9.6'), false);
  assert.equal(onlyBinHerdrMissesThePin(await versionsFrom('0.9.5', '0.9.7', '{"running":true,"version":"0.9.6"}'), 'v0.9.6'), false);
  assert.equal(onlyBinHerdrMissesThePin(await versionsFrom('0.9.6', '0.9.6', '{"running":true,"version":"0.9.6"}'), 'v0.9.6'), false);
});

test('a stopped service is not at the pin', async () => {
  assert.equal(herdrIsAtPin(await versionsFrom('0.9.6', '0.9.6', '{"running":false,"version":null}'), 'v0.9.6'), false);
});
