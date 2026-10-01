import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { LINUX_UNITS } from './linux.ts';
import {
  renderUnitSource,
  SYSTEMD_SOURCE_DIR,
  SYSTEMD_UNIT_NAMES,
} from './service-unit-renderer.service.ts';

const TOKENS = {
  throneRoot: '/srv/throne',
  herdrBin: '/srv/herdr/v9/herdr',
  nodeBin: '/srv/mise/node/lts/bin/node',
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
