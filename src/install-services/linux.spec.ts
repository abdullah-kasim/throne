import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { LINUX_UNITS, linuxUnitsForHost, RETIRED_LINUX_UNITS } from './linux.ts';
import {
  renderUnitSource,
  SYSTEMD_SOURCE_DIR,
  SYSTEMD_UNIT_NAMES,
} from './service-unit-renderer.service.ts';

const TOKENS = {
  throneRoot: '/srv/throne',
  herdrBin: '/srv/herdr/v9/herdr',
  nodeBin: '/srv/mise/node/24.19.0/bin/node',
};

test('every committed conduwuit systemd source renders with the linux token set and no leftover token', async () => {
  const conduwuitBasenames = [
    SYSTEMD_UNIT_NAMES.CONDUWUIT,
    SYSTEMD_UNIT_NAMES.CONDUWUIT_MEDIA_SWEEP_SERVICE,
    SYSTEMD_UNIT_NAMES.CONDUWUIT_MEDIA_SWEEP_TIMER,
  ];
  for (const basename of conduwuitBasenames) {
    assert.ok(
      LINUX_UNITS.some((unit) => unit.basename === basename),
      `${basename} missing from LINUX_UNITS`,
    );
    const source = await readFile(path.join(SYSTEMD_SOURCE_DIR, basename), 'utf8');
    const rendered = renderUnitSource(source, TOKENS);
    assert.doesNotMatch(rendered, /\{\{/);
  }
});

test('conduwuit.service execs conduwuit-serve at the substituted throne root', async () => {
  const source = await readFile(
    path.join(SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES.CONDUWUIT),
    'utf8',
  );
  const rendered = renderUnitSource(source, TOKENS);
  assert.match(rendered, /ExecStart=\/srv\/throne\/systemd\/conduwuit-serve \/srv\/throne\/systemd\/conduwuit\.toml/);
  assert.match(rendered, /StateDirectory=conduwuit/);
});

test('the conduwuit media sweep pair follows the timer/oneshot split: only the timer is enabled directly', async () => {
  const service = LINUX_UNITS.find(
    (unit) => unit.basename === SYSTEMD_UNIT_NAMES.CONDUWUIT_MEDIA_SWEEP_SERVICE,
  );
  const timer = LINUX_UNITS.find(
    (unit) => unit.basename === SYSTEMD_UNIT_NAMES.CONDUWUIT_MEDIA_SWEEP_TIMER,
  );
  assert.equal(service?.enabledDirectly, false);
  assert.equal(timer?.enabledDirectly, true);
});

test('every committed throne-bot systemd source is registered, renders with the linux token set, and is never enabled directly by install-services', async () => {
  const throneBotBasenames = [
    SYSTEMD_UNIT_NAMES.THRONE_BOT_HERDR,
    SYSTEMD_UNIT_NAMES.THRONE_BOT_BRIDGE_TEMPLATE,
  ];
  for (const basename of throneBotBasenames) {
    const unit = LINUX_UNITS.find((candidate) => candidate.basename === basename);
    assert.ok(unit, `${basename} missing from LINUX_UNITS`);
    assert.equal(
      unit?.enabledDirectly,
      false,
      `${basename} must be started explicitly by install-throne-bot.sh, not enabled by install-services`,
    );
    const source = await readFile(path.join(SYSTEMD_SOURCE_DIR, basename), 'utf8');
    const rendered = renderUnitSource(source, TOKENS);
    assert.doesNotMatch(rendered, /\{\{/);
  }
});

test("the rendered forgejo.service runs this checkout's forgejo-serve with the absolute node path and restarts on failure", async () => {
  const source = await readFile(
    path.join(SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES.FORGEJO),
    'utf8',
  );
  const ntfySource = await readFile(
    path.join(SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES.NTFY),
    'utf8',
  );
  const rendered = renderUnitSource(source, TOKENS);
  assert.doesNotMatch(rendered, /\{\{/);
  assert.match(rendered, /^ExecStart=\/srv\/throne\/systemd\/forgejo-serve$/m);
  assert.match(rendered, /^Environment=FORGEJO_NODE_BIN=\/srv\/mise\/node\/24\.19\.0\/bin\/node$/m);
  assert.match(rendered, /^Restart=on-failure$/m);
  assert.match(rendered, /^StateDirectory=forgejo$/m);
  for (const bootRaceRetry of [/^StartLimitIntervalSec=.*$/m, /^StartLimitBurst=.*$/m, /^RestartSec=.*$/m, /^TimeoutStartSec=.*$/m]) {
    assert.equal(rendered.match(bootRaceRetry)?.[0], ntfySource.match(bootRaceRetry)?.[0]);
  }
});

test('the ~/tmp cache cleaner timer is installed and enabled and nothing retires it', async () => {
  const hostUnits = linuxUnitsForHost(false);
  const service = hostUnits.find(
    (unit) => unit.basename === SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_SERVICE,
  );
  const timer = hostUnits.find(
    (unit) => unit.basename === SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_TIMER,
  );
  assert.equal(service?.enabledDirectly, false);
  assert.equal(timer?.enabledDirectly, true);
  assert.ok(!RETIRED_LINUX_UNITS.includes(SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_SERVICE));
  assert.ok(!RETIRED_LINUX_UNITS.includes(SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_TIMER));
  const source = await readFile(
    path.join(SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES.SWEEP_TMP_SCRATCH_HOME_SERVICE),
    'utf8',
  );
  const rendered = renderUnitSource(source, TOKENS);
  assert.match(
    rendered,
    /^ExecStart=\/srv\/mise\/node\/24\.19\.0\/bin\/node \/srv\/throne\/dist\/src\/tools\.js sweep-tmp-scratch --apply --tmp-root %h\/tmp --min-age-ms 2592000000 --min-free-bytes 100000000000$/m,
  );
});
