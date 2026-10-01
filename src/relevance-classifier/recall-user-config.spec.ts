import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_RECALL_CONFIG,
  loadRecallConfig,
  pathWithHomeExpanded,
} from './recall-user-config.ts';

function configFileContaining(source: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'recall-config-'));
  const configPath = path.join(directory, 'config.user.ts');
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(configPath, source);
  return configPath;
}

test('an absent config file keeps Jev and the hook switched off', async () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), 'recall-config-')), 'config.user.ts');
  const config = await loadRecallConfig(configPath);
  assert.deepEqual(config, DEFAULT_RECALL_CONFIG);
  assert.equal(config.jevEnabled, false);
  assert.equal(config.hookEnabled, false);
  assert.equal(config.serveThreshold, 0.5);
  assert.equal(config.serveThresholdWhenCostIsHigh, 0.3);
});

test('a config file without a recall section keeps the defaults', async () => {
  const config = await loadRecallConfig(configFileContaining('export default { steering: {} };'));
  assert.deepEqual(config, DEFAULT_RECALL_CONFIG);
});

test('a recall section overrides only the fields it names', async () => {
  const config = await loadRecallConfig(
    configFileContaining(
      "export default { recall: { jevEnabled: true, serveThreshold: 0.7, globalMemoryDirectories: ['~/memories'] } };",
    ),
  );
  assert.deepEqual(config, {
    ...DEFAULT_RECALL_CONFIG,
    jevEnabled: true,
    serveThreshold: 0.7,
    globalMemoryDirectories: ['~/memories'],
  });
});

const REFUSED_SECTIONS: readonly [string, RegExp][] = [
  ["{ jevEnabled: 'yes' }", /`jevEnabled` must be a boolean/],
  ['{ serveThreshold: 1.5 }', /`serveThreshold` must be a number from 0 to 1/],
  ['{ verdictLineThreshold: 1.5 }', /`verdictLineThreshold` must be a number from 0 to 1/],
  ['{ maximumInjectedCharacters: 0 }', /`maximumInjectedCharacters` must be an integer >= 1/],
  ['{ globalMemoryDirectories: [7] }', /`globalMemoryDirectories` must be an array/],
  ['{ jevApiKey: "x" }', /`recall.jevApiKey` is not a known field/],
];

test('the Jev day and hour limits default to 15,000,000 and 1,250,000 tokens', async () => {
  const config = await loadRecallConfig(configFileContaining('export default { recall: {} };'));
  assert.equal(config.jevTokensPerDay, 15_000_000);
  assert.equal(config.jevTokensPerHour, 1_250_000);
});

test('a Jev limit set in config.user.ts replaces its default', async () => {
  const config = await loadRecallConfig(
    configFileContaining('export default { recall: { jevTokensPerDay: 2_000_000, jevTokensPerHour: 0 } };'),
  );
  assert.equal(config.jevTokensPerDay, 2_000_000);
  assert.equal(config.jevTokensPerHour, 0);
});

for (const [section, field] of [
  ['{ jevTokensPerDay: -1 }', 'jevTokensPerDay'],
  ['{ jevTokensPerDay: 1.5 }', 'jevTokensPerDay'],
  ["{ jevTokensPerHour: '100' }", 'jevTokensPerHour'],
  ['{ jevTokensPerHour: Number.POSITIVE_INFINITY }', 'jevTokensPerHour'],
] as const) {
  test(`a Jev limit that is not a whole number of zero or more is refused with the field named: ${section}`, async () => {
    await assert.rejects(
      loadRecallConfig(configFileContaining(`export default { recall: ${section} };`)),
      new RegExp(`\`${field}\` must be an integer >= 0`),
    );
  });
}

for (const field of ['jevTokensPerMinute', 'jevRequestsPerMinute']) {
  test(`the per-minute Jev limits are not recall fields: ${field}`, async () => {
    await assert.rejects(
      loadRecallConfig(configFileContaining(`export default { recall: { ${field}: 60 } };`)),
      new RegExp(`\`recall\\.${field}\` is not a known field`),
    );
  });
}

for (const [section, expectedMessage] of REFUSED_SECTIONS) {
  test(`recall section ${section} is refused by name`, async () => {
    await assert.rejects(
      loadRecallConfig(configFileContaining(`export default { recall: ${section} };`)),
      expectedMessage,
    );
  });
}

test('a hook mode other than serve, shadow or split is refused with the allowed values named', async () => {
  await assert.rejects(
    loadRecallConfig(configFileContaining("export default { recall: { hookMode: 'coin' } };")),
    /`hookMode` must be one of 'serve', 'shadow', 'split' \(got a string\)/,
  );
  const config = await loadRecallConfig(
    configFileContaining("export default { recall: { hookMode: 'split', verdictLineThreshold: 0.8 } };"),
  );
  assert.equal(config.hookMode, 'split');
  assert.equal(config.verdictLineThreshold, 0.8);
});

test('a leading tilde expands to the home directory', () => {
  assert.equal(pathWithHomeExpanded('~/.jev-key', '/home/someone'), '/home/someone/.jev-key');
  assert.equal(pathWithHomeExpanded('/etc/key', '/home/someone'), '/etc/key');
});
