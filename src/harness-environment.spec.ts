import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadUserConfigFile } from './user-config-loader.ts';
import { readConfiguredHarnessEnvironment } from './herdr/herdr-tab.service.ts';
import { renderHarnessEnvironmentLines } from './check-config/check-config.ts';

async function configFileContaining(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-environment-'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  const configPath = path.join(directory, 'config.user.ts');
  await writeFile(configPath, source);
  return configPath;
}

async function configWithSection(section: unknown): Promise<string> {
  return configFileContaining(`export default { harnessEnvironment: ${JSON.stringify(section)} };`);
}

async function refusalFor(section: unknown): Promise<string> {
  const configPath = await configWithSection(section);
  try {
    await loadUserConfigFile(configPath);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail('the config should have been refused');
}

test('a harness environment value that is not a string is refused naming its key', async () => {
  assert.match(await refusalFor({ claude: { MY_FLAG: 1 } }), /`harnessEnvironment\.claude\.MY_FLAG` must be a string/);
});

test('a harness environment for an unknown harness is refused naming its key', async () => {
  assert.match(await refusalFor({ claudy: { MY_FLAG: 'on' } }), /`harnessEnvironment\.claudy` is not a known harness/);
});

test('a harness environment entry that is not an object is refused naming its key', async () => {
  assert.match(await refusalFor({ claude: 'MY_FLAG=on' }), /`harnessEnvironment\.claude` must be a plain object/);
  assert.match(await refusalFor(['claude']), /`harnessEnvironment` must be a plain object/);
});

test('every variable name throne reserves for itself is refused naming its key', async () => {
  for (const name of ['THRONE_ANYTHING', 'GIT_ANYTHING', 'HERDR_ANYTHING', 'PATH', 'HOME', 'CLAUDE_BIN', 'CODEX_BIN']) {
    assert.match(
      await refusalFor({ codex: { [name]: 'x' } }),
      new RegExp(`\`harnessEnvironment\\.codex\\.${name}\` is reserved for throne`),
    );
  }
});

test('an absent or empty harness environment adds no variable to any launch', async () => {
  const absent = await configFileContaining('export default {};');
  const empty = await configWithSection({});
  assert.deepEqual(await readConfiguredHarnessEnvironment('claude', absent), {});
  assert.deepEqual(await readConfiguredHarnessEnvironment('claude', empty), {});
});

test('a launch reads only the variables configured for its own harness', async () => {
  const configPath = await configWithSection({ claude: { MY_FLAG: 'on' } });
  assert.deepEqual(await readConfiguredHarnessEnvironment('claude', configPath), { MY_FLAG: 'on' });
  assert.deepEqual(await readConfiguredHarnessEnvironment('pi', configPath), {});
});

test('a config that cannot be loaded launches without the extra variables', async () => {
  const configPath = await configWithSection({ claude: { PATH: '/x' } });
  assert.deepEqual(await readConfiguredHarnessEnvironment('claude', configPath), {});
});

test('check-config names the configured variables and never prints a value', async () => {
  const configPath = await configWithSection({ claude: { MY_FLAG: 'secret-value-123' }, pi: {} });
  const lines = await renderHarnessEnvironmentLines(configPath);
  assert.match(lines, /^harness environment claude: MY_FLAG$/m);
  assert.match(lines, /^harness environment pi: none$/m);
  assert.doesNotMatch(lines, /secret-value-123/);
});
