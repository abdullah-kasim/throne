import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FEATURE_FLAGS,
  loadFeatureFlags,
  parseFeatureFlags,
  shouldUseFileBackedAgentPayloads,
} from './feature-flags.service.ts';

const FEATURES_PATH = '/home/example/.config/throne/features.json';

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
