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

test('an absent config file keeps the defaults', async () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), 'recall-config-')), 'config.user.ts');
  const config = await loadRecallConfig(configPath);
  assert.deepEqual(config, DEFAULT_RECALL_CONFIG);
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
      "export default { recall: { verdictLineThreshold: 0.8, serveThreshold: 0.7, globalMemoryDirectories: ['~/memories'] } };",
    ),
  );
  assert.deepEqual(config, {
    ...DEFAULT_RECALL_CONFIG,
    verdictLineThreshold: 0.8,
    serveThreshold: 0.7,
    globalMemoryDirectories: ['~/memories'],
  });
});

const REFUSED_SECTIONS: readonly [string, RegExp][] = [
  ['{ serveThreshold: 1.5 }', /`serveThreshold` must be a number from 0 to 1/],
  ['{ verdictLineThreshold: 1.5 }', /`verdictLineThreshold` must be a number from 0 to 1/],
  ['{ maximumInjectedCharacters: 0 }', /`maximumInjectedCharacters` must be an integer >= 1/],
  ['{ globalMemoryDirectories: [7] }', /`globalMemoryDirectories` must be an array/],
];

test('a config file that still names a removed recall field loads and says the field is no longer read', async () => {
  const retiredField = 'rankAllowedRoots';
  const configPath = configFileContaining(`export default { recall: { ${retiredField}: true, serveThreshold: 0.7 } };`);
  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((text: string) => {
    stderrLines.push(text);
    return true;
  }) as typeof process.stderr.write;
  try {
    const config = await loadRecallConfig(configPath);
    assert.deepEqual(config, { ...DEFAULT_RECALL_CONFIG, serveThreshold: 0.7 });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.deepEqual(stderrLines, [`recall.${retiredField} in "${configPath}" is no longer read; delete it.
`]);
});

for (const [section, expectedMessage] of REFUSED_SECTIONS) {
  test(`recall section ${section} is refused by name`, async () => {
    await assert.rejects(
      loadRecallConfig(configFileContaining(`export default { recall: ${section} };`)),
      expectedMessage,
    );
  });
}

const REMOVED_RECALL_HOOK_FIELDS = ['Enabled', 'Mode', 'TimeoutMilliseconds'].map((suffix) => `hook${suffix}`);

test('a config.user.ts that still names a removed recall hook field loads with a one-line notice', async () => {
  for (const removedField of REMOVED_RECALL_HOOK_FIELDS) {
    const configPath = configFileContaining(`export default { recall: { ${removedField}: true, serveThreshold: 0.7 } };`);
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((text: string) => {
      stderrLines.push(text);
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.deepEqual(await loadRecallConfig(configPath), { ...DEFAULT_RECALL_CONFIG, serveThreshold: 0.7 });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.deepEqual(stderrLines, [`recall.${removedField} in "${configPath}" is no longer read; delete it.\n`]);
  }
});

test('a leading tilde expands to the home directory', () => {
  assert.equal(pathWithHomeExpanded('~/.key', '/home/someone'), '/home/someone/.key');
  assert.equal(pathWithHomeExpanded('/etc/key', '/home/someone'), '/etc/key');
});
