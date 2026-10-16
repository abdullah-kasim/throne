import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveThroneHome,
  throneBrowserProfilesDirectory,
  throneConfigDirectory,
  throneHomeOfThisMachine,
  throneLogsDirectory,
} from './throne-home.ts';

const USER_HOME = '/home/example';
const OVERRIDDEN_HOME = '/srv/scratch-throne';

function homeOfThisMachineOrItsError(): string {
  try {
    return throneHomeOfThisMachine();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('the throne home is the THRONE_DATA_HOME folder when it is set', () => {
  assert.equal(resolveThroneHome({ THRONE_DATA_HOME: OVERRIDDEN_HOME }, USER_HOME), OVERRIDDEN_HOME);
});

test("the throne home is the .throne folder in the user's home when no override is set", () => {
  assert.equal(resolveThroneHome({}, USER_HOME), '/home/example/.throne');
});

test('a relative THRONE_DATA_HOME is refused', () => {
  assert.throws(() => resolveThroneHome({ THRONE_DATA_HOME: 'relative/home' }, USER_HOME), /THRONE_DATA_HOME must be an absolute path/);
});

test('settings, browser sign-ins and logs live in their own folders inside the throne home', () => {
  for (const [environment, home] of [
    [{}, '/home/example/.throne'],
    [{ THRONE_DATA_HOME: OVERRIDDEN_HOME }, OVERRIDDEN_HOME],
  ] as const) {
    assert.equal(throneConfigDirectory(environment, USER_HOME), path.join(home, 'config'));
    assert.equal(throneBrowserProfilesDirectory(environment, USER_HOME), path.join(home, 'browser-profiles'));
    assert.equal(throneLogsDirectory(environment, USER_HOME), path.join(home, 'logs'));
  }
});

test("the Jev budget's home ignores THRONE_DATA_HOME and HOME", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'throne-home-'));
  const original = { HOME: process.env.HOME, THRONE_DATA_HOME: process.env.THRONE_DATA_HOME };
  const homeBeforeRedirect = homeOfThisMachineOrItsError();
  try {
    process.env.HOME = scratch;
    process.env.THRONE_DATA_HOME = scratch;
    const homeAfterRedirect = homeOfThisMachineOrItsError();
    assert.equal(homeAfterRedirect, homeBeforeRedirect);
    assert.ok(!homeAfterRedirect.startsWith(scratch), homeAfterRedirect);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
