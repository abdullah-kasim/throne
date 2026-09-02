import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scanSuiteContainers,
  SUITE_CONTAINER_AGE_THRESHOLD_SECONDS,
} from './container-scan.ts';

test('an aged throne suite container is reported without inspecting ordinary containers', async () => {
  const nowEpochSeconds = 10_000;
  const result = await scanSuiteContainers(
    nowEpochSeconds,
    async () =>
      JSON.stringify([
        { Names: ['throne-suite-app'], Created: nowEpochSeconds - SUITE_CONTAINER_AGE_THRESHOLD_SECONDS },
        { Names: ['ordinary-container'], Created: nowEpochSeconds - 9_000 },
      ]),
  );

  assert.deepEqual(result, {
    state: 'scanned',
    total: 1,
    aged: [
      {
        name: 'throne-suite-app',
        ageSeconds: SUITE_CONTAINER_AGE_THRESHOLD_SECONDS,
        ageText: '2h00m',
      },
    ],
  });
});

test('an unavailable container listing remains distinguishable from an empty scan', async () => {
  const result = await scanSuiteContainers(10_000, async () => {
    throw new Error('podman unavailable');
  });

  assert.deepEqual(result, { state: 'unavailable', reason: 'podman unavailable' });
});
