import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enableThrone, disableThrone, type ThroneLifecycleDeps } from './throne-lifecycle.ts';
import { SYSTEMD_UNIT_NAMES } from '../install-services/service-unit-renderer.service.ts';

function makeDeps(): ThroneLifecycleDeps & { calledUnits: string[] } {
  const calledUnits: string[] = [];
  return {
    calledUnits,
    systemctl: async (args) => {
      calledUnits.push(args[args.length - 1]);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('enable-throne no longer tries to enable retired timer units', async () => {
  const deps = makeDeps();
  await enableThrone(deps);
  assert.ok(!deps.calledUnits.includes(SYSTEMD_UNIT_NAMES.KEEP_GOING_TIMER));
  assert.ok(!deps.calledUnits.includes(SYSTEMD_UNIT_NAMES.NO_IDLING_TIMER));
});

test('disable-throne no longer tries to disable retired timer units', async () => {
  const deps = makeDeps();
  await disableThrone(deps);
  assert.ok(!deps.calledUnits.includes(SYSTEMD_UNIT_NAMES.KEEP_GOING_TIMER));
  assert.ok(!deps.calledUnits.includes(SYSTEMD_UNIT_NAMES.NO_IDLING_TIMER));
});

test('enable-throne brings throne-backend.service to an enabled and started state', async () => {
  const deps = makeDeps();
  await enableThrone(deps);
  assert.deepEqual(new Set(deps.calledUnits), new Set([SYSTEMD_UNIT_NAMES.NTFY, SYSTEMD_UNIT_NAMES.THRONE_BACKEND]));
});

test('disable-throne never stops or disables throne-backend.service', async () => {
  const deps = makeDeps();
  await disableThrone(deps);
  assert.ok(!deps.calledUnits.includes(SYSTEMD_UNIT_NAMES.THRONE_BACKEND));
  assert.deepEqual(deps.calledUnits, [SYSTEMD_UNIT_NAMES.NTFY]);
});
