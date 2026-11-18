import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveThroneHome,
  throneBrowserProfilesDirectory,
  throneConfigDirectory,
  throneLogsDirectory,
} from './throne-home.ts';

const USER_HOME = '/home/example';
const OVERRIDDEN_HOME = '/srv/scratch-throne';

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
