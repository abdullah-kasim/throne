import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  DEFAULT_FEATURE_FLAGS,
  featureFlagsPath,
  loadFeatureFlags,
  parseFeatureFlags,
  shouldUseFileBackedAgentPayloads,
} from './feature-flags.service.ts';

const FEATURES_PATH = '/home/example/.throne/config/features.json';
const SWITCHED_ON = '{"send-agent-file-backed-payloads": true}';

const scratchDirectories: string[] = [];
after(() => Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true }))));

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'throne-feature-flags-'));
  scratchDirectories.push(directory);
  return directory;
}

async function writeFeaturesFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test('feature flags are read from the config folder in the throne home', async () => {
  const userHome = await scratchDirectory();
  await writeFeaturesFile(path.join(userHome, '.throne', 'config', 'features.json'), SWITCHED_ON);

  const flags = loadFeatureFlags(featureFlagsPath({}, userHome));

  assert.equal(shouldUseFileBackedAgentPayloads(flags), true);
});

test('feature flags follow THRONE_DATA_HOME and ignore XDG_CONFIG_HOME', async () => {
  const throneHome = await scratchDirectory();
  const xdgConfigHome = await scratchDirectory();
  await writeFeaturesFile(path.join(xdgConfigHome, 'throne', 'features.json'), SWITCHED_ON);
  const environment = { THRONE_DATA_HOME: throneHome, XDG_CONFIG_HOME: xdgConfigHome };

  assert.equal(shouldUseFileBackedAgentPayloads(loadFeatureFlags(featureFlagsPath(environment))), false);

  await writeFeaturesFile(path.join(throneHome, 'config', 'features.json'), SWITCHED_ON);
  assert.equal(shouldUseFileBackedAgentPayloads(loadFeatureFlags(featureFlagsPath(environment))), true);
});

test('the live features file that still names the retired herdr-decouple and harness-decouple flags loads without error', () => {
  const flags = loadFeatureFlags(
    FEATURES_PATH,
    () => '{"herdr-decouple": true, "harness-decouple": true}',
  );
  assert.deepEqual(flags, DEFAULT_FEATURE_FLAGS);
});

test('a features file that names an unknown flag is still refused', () => {
  assert.throws(
    () => parseFeatureFlags('{"herdr-decouple": true, "made-up-flag": true}', FEATURES_PATH),
    /unknown flag "made-up-flag"/,
  );
});

test('file-backed send-agent payloads can still be switched on and off', () => {
  const switchedOn = parseFeatureFlags('{"send-agent-file-backed-payloads": true}', FEATURES_PATH);
  const switchedOff = parseFeatureFlags('{"send-agent-file-backed-payloads": false}', FEATURES_PATH);
  assert.equal(shouldUseFileBackedAgentPayloads(switchedOn), true);
  assert.equal(shouldUseFileBackedAgentPayloads(switchedOff), false);
  assert.throws(
    () => parseFeatureFlags('{"send-agent-file-backed-payloads": "yes"}', FEATURES_PATH),
    /must be boolean/,
  );
});
