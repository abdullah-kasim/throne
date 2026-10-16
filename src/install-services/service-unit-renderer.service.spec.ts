import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { darwinAgentsForHost } from './darwin.ts';
import { LAUNCHD_SOURCE_DIR, renderUnitSource } from './service-unit-renderer.service.ts';

const TOKENS = { throneRoot: '/opt/throne', herdrBin: '/opt/herdr', nodeBin: '/opt/node/bin/node' };

async function renderedUnitsThatWriteLogs(environment: NodeJS.ProcessEnv): Promise<Map<string, string>> {
  const rendered = new Map<string, string>();
  for (const agent of darwinAgentsForHost(true)) {
    const source = await readFile(path.join(LAUNCHD_SOURCE_DIR, agent.basename), 'utf8');
    const unit = renderUnitSource(source, TOKENS, environment);
    if (unit.includes('&gt;&gt;')) {
      rendered.set(agent.basename, unit);
    }
  }
  return rendered;
}

function assertLogsGoTo(units: Map<string, string>, logsFolder: string): void {
  assert.deepEqual(
    [...units.keys()].sort(),
    ['com.throne.forgejo.plist', 'com.throne.ntfy.plist', 'com.throne.throne-backend.plist', 'com.throne.throne-herdr.plist'],
  );
  for (const [basename, unit] of units) {
    assert.ok(unit.includes(`mkdir -p "${logsFolder}"`), `${basename} does not create ${logsFolder}`);
    assert.match(unit, new RegExp(`&gt;&gt; "${logsFolder.replaceAll('.', '\\.')}/[a-z-]+\\.log"`), `${basename} does not log into ${logsFolder}`);
    assert.doesNotMatch(unit, /Library\/Logs/, `${basename} still names the old log folder`);
  }
}

test('rendered launchd units write their logs to the logs folder in the throne home', async () => {
  assertLogsGoTo(await renderedUnitsThatWriteLogs({}), path.join(os.homedir(), '.throne', 'logs'));
});

test('rendered launchd units follow THRONE_DATA_HOME for their log folder', async () => {
  assertLogsGoTo(await renderedUnitsThatWriteLogs({ THRONE_DATA_HOME: '/srv/throne-home' }), '/srv/throne-home/logs');
});

test('a unit source with an unknown placeholder is still refused', () => {
  assert.throws(
    () => renderUnitSource('ExecStart={{THRONE_ROOT}}/run {{NOT_A_TOKEN}}', TOKENS, {}),
    /unresolved template token \{\{NOT_A_TOKEN\}\}/,
  );
});
