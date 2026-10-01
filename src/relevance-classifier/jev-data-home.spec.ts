import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { jevBudgetDirectory } from './jev-budget.ts';
import { THRONE_HOME_DIRECTORY_NAME } from './jev-data-home.ts';
import { jevPathsOfARunWithEnvironment, jevPathsOfThisRun } from './jev-data-home.test-support.ts';
import { jevUsageLogPath } from './jev-usage-log.ts';

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('a run with HOME and THRONE_DATA_HOME pointed at a scratch directory draws down the live budget, not a fresh one', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'jev-data-home-'));
  try {
    const redirected = await jevPathsOfARunWithEnvironment({
      ...process.env,
      HOME: scratch,
      THRONE_DATA_HOME: scratch,
      THRONE_LIVE_ROOT: scratch,
    });
    assert.deepEqual(redirected, jevPathsOfThisRun());
    for (const resolvedPath of [redirected.budgetDirectory ?? '', redirected.usageLog ?? '']) {
      assert.ok(!resolvedPath.startsWith(scratch), resolvedPath);
    }
    for (const dataHomeTheEnvironmentNames of [scratch, path.join(scratch, THRONE_HOME_DIRECTORY_NAME)]) {
      for (const jevPath of [jevBudgetDirectory(dataHomeTheEnvironmentNames), jevUsageLogPath(dataHomeTheEnvironmentNames)]) {
        assert.equal(await exists(jevPath), false, jevPath);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
