import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DARWIN_AGENTS,
  installDarwinServices,
  RETIRED_DARWIN_AGENTS,
} from './darwin.ts';
import { LINUX_UNITS, RETIRED_LINUX_UNITS } from './linux.ts';
import {
  LAUNCH_AGENTS_DIR,
  LAUNCHD_AGENT_NAMES,
  LAUNCHD_SOURCE_DIR,
  renderUnitSource,
  SYSTEMD_SOURCE_DIR,
  type InstalledUnit,
  type ServiceCommandResult,
} from './service-unit-renderer.service.ts';
import type { InstallServicesDeps, InstallServicesOptions } from './install-services.types.ts';

const TOKENS = {
  throneRoot: '/srv/throne',
  herdrBin: '/srv/herdr/v9/herdr',
  nodeBin: '/srv/mise/node/lts/bin/node',
};

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

const OPTIONS: InstallServicesOptions = {
  dryRun: false,
  throneRoot: TOKENS.throneRoot,
  throneRootExplicit: false,
};

interface FakeWorld {
  loadedLabels: Set<string>;
  installedPlists: Map<string, string>;
  launchctlCalls: string[][];
  removed: string[];
}

function makeDeps(world: FakeWorld): InstallServicesDeps {
  const ok: ServiceCommandResult = { code: 0, stdout: '', stderr: '' };
  const missing: ServiceCommandResult = { code: 113, stdout: '', stderr: 'Could not find service' };
  return {
    platform: 'darwin',
    arch: 'arm64',
    userId: () => 501,
    launchctl: async (args) => {
      world.launchctlCalls.push(args);
      const [verb, target] = args;
      const label = target?.split('/').pop() ?? '';
      if (verb === 'print') {
        return world.loadedLabels.has(label) ? ok : missing;
      }
      if (verb === 'bootout') {
        world.loadedLabels.delete(label);
      }
      if (verb === 'bootstrap') {
        world.loadedLabels.add(path.basename(args[2]).replace(/\.plist$/, ''));
      }
      return ok;
    },
    systemctl: async () => {
      throw new Error('systemctl must never be called on darwin');
    },
    readUnitSource: (sourcePath) => readFile(sourcePath, 'utf8'),
    inspectInstalledUnit: async (targetPath): Promise<InstalledUnit> => {
      const content = world.installedPlists.get(targetPath);
      return content === undefined
        ? { kind: 'missing', content: '' }
        : { kind: 'file', content };
    },
    writeUnitFile: async (targetPath, content) => {
      world.installedPlists.set(targetPath, content);
    },
    removeUnitFile: async (targetPath) => {
      world.installedPlists.delete(targetPath);
      world.removed.push(path.basename(targetPath));
    },
    resolveNodeBin: () => TOKENS.nodeBin,
    ownedHerdrPath: () => TOKENS.herdrBin,
    herdrCacheDirectory: () => '/srv/cache',
    installHerdr: async () => {
      throw new Error('not exercised');
    },
    throneCommandPath: () => '/srv/bin/throne',
    inspectThroneCommand: async () => ({ kind: 'missing' }),
    createThroneCommandSymlink: async () => {},
    herdrDecoupleEnabled: () => true,
    pathSymlinkTargets: () => [],
    inspectPathSymlink: async () => ({ kind: 'missing' }),
    writePathSymlink: async () => {},
  };
}

function emptyWorld(): FakeWorld {
  return {
    loadedLabels: new Set(),
    installedPlists: new Map(),
    launchctlCalls: [],
    removed: [],
  };
}

test('every unit install-services renders has a committed source, and every retired one does not', async () => {
  for (const unit of LINUX_UNITS) {
    assert.ok(await exists(path.join(SYSTEMD_SOURCE_DIR, unit.basename)), `systemd/${unit.basename} missing`);
  }
  for (const agent of DARWIN_AGENTS) {
    assert.ok(await exists(path.join(LAUNCHD_SOURCE_DIR, agent.basename)), `launchd/${agent.basename} missing`);
  }
  for (const basename of RETIRED_LINUX_UNITS) {
    assert.ok(!(await exists(path.join(SYSTEMD_SOURCE_DIR, basename))), `retired systemd/${basename} still committed`);
  }
  for (const agent of RETIRED_DARWIN_AGENTS) {
    assert.ok(!(await exists(path.join(LAUNCHD_SOURCE_DIR, agent.basename))), `retired launchd/${agent.basename} still committed`);
    assert.ok(!DARWIN_AGENTS.some((live) => live.basename === agent.basename), `${agent.basename} both live and retired`);
  }
});

test('every committed launchd source renders with the darwin token set and no leftover token', async () => {
  for (const agent of DARWIN_AGENTS) {
    const source = await readFile(path.join(LAUNCHD_SOURCE_DIR, agent.basename), 'utf8');
    const rendered = renderUnitSource(source, TOKENS);
    assert.match(rendered, new RegExp(`<string>${agent.label}</string>`));
    assert.doesNotMatch(rendered, /\{\{/);
  }
});

test('a fresh mac gets ntfy, throne-herdr and throne-backend bootstrapped', async () => {
  const world = emptyWorld();
  const result = await installDarwinServices(makeDeps(world), OPTIONS, TOKENS.herdrBin, DARWIN_AGENTS, RETIRED_DARWIN_AGENTS);
  assert.equal(result.status, 'installed');
  assert.deepEqual(
    [...world.installedPlists.keys()].map((target) => path.basename(target)).sort(),
    DARWIN_AGENTS.map((agent) => agent.basename).sort(),
  );
  const bootstrapped = world.launchctlCalls
    .filter(([verb]) => verb === 'bootstrap')
    .map((args) => path.basename(args[2]));
  assert.deepEqual(bootstrapped.sort(), [
    LAUNCHD_AGENT_NAMES.NTFY.basename,
    LAUNCHD_AGENT_NAMES.THRONE_BACKEND.basename,
    LAUNCHD_AGENT_NAMES.THRONE_HERDR.basename,
  ]);
  assert.ok(world.launchctlCalls.every(([verb]) => verb !== 'bootout'));
  assert.deepEqual(world.removed, []);
  for (const args of world.launchctlCalls.filter(([verb]) => verb === 'bootstrap')) {
    assert.equal(args[1], 'gui/501');
    assert.ok(args[2].startsWith(LAUNCH_AGENTS_DIR));
  }
});

test('a pre-consolidation mac gets its legacy agents booted out and removed before the live set is bootstrapped', async () => {
  const world = emptyWorld();
  for (const legacy of RETIRED_DARWIN_AGENTS) {
    world.loadedLabels.add(legacy.label);
    world.installedPlists.set(path.join(LAUNCH_AGENTS_DIR, legacy.basename), 'old');
  }
  const result = await installDarwinServices(makeDeps(world), OPTIONS, TOKENS.herdrBin, DARWIN_AGENTS, RETIRED_DARWIN_AGENTS);
  assert.equal(result.status, 'installed');
  const bootedOut = world.launchctlCalls
    .filter(([verb]) => verb === 'bootout')
    .map(([, target]) => target);
  assert.deepEqual(bootedOut.sort(), RETIRED_DARWIN_AGENTS.map((agent) => `gui/501/${agent.label}`).sort());
  assert.deepEqual(world.removed.sort(), RETIRED_DARWIN_AGENTS.map((agent) => agent.basename).sort());
  assert.ok(world.launchctlCalls.every(([verb]) => verb !== 'disable'), 'disable would persist and block a future bootstrap');
  const firstBootstrap = world.launchctlCalls.findIndex(([verb]) => verb === 'bootstrap');
  const lastBootout = world.launchctlCalls.map(([verb]) => verb).lastIndexOf('bootout');
  assert.ok(lastBootout < firstBootstrap, 'retirement must run before any bootstrap');
  for (const legacy of RETIRED_DARWIN_AGENTS) {
    assert.ok(!world.loadedLabels.has(legacy.label));
  }
  assert.ok(world.loadedLabels.has(LAUNCHD_AGENT_NAMES.THRONE_HERDR.label));
  assert.ok(world.loadedLabels.has(LAUNCHD_AGENT_NAMES.THRONE_BACKEND.label));
});

test('a second run is a no-op: nothing rewritten, no launchctl mutation, retired agents untouched', async () => {
  const world = emptyWorld();
  const deps = makeDeps(world);
  await installDarwinServices(deps, OPTIONS, TOKENS.herdrBin, DARWIN_AGENTS, RETIRED_DARWIN_AGENTS);
  world.launchctlCalls.length = 0;
  const result = await installDarwinServices(deps, OPTIONS, TOKENS.herdrBin, DARWIN_AGENTS, RETIRED_DARWIN_AGENTS);
  assert.equal(result.status, 'unchanged');
  assert.deepEqual(result.changedWhileRunning, []);
  assert.ok(world.launchctlCalls.every(([verb]) => verb === 'print'));
  assert.deepEqual(world.removed, []);
});

test('dry-run reports the plan for a pre-consolidation mac and mutates nothing', async () => {
  const world = emptyWorld();
  world.loadedLabels.add(LAUNCHD_AGENT_NAMES.HERDR_SERVER.label);
  world.installedPlists.set(path.join(LAUNCH_AGENTS_DIR, LAUNCHD_AGENT_NAMES.HERDR_SERVER.basename), 'old');
  const result = await installDarwinServices(makeDeps(world), { ...OPTIONS, dryRun: true }, TOKENS.herdrBin, DARWIN_AGENTS, RETIRED_DARWIN_AGENTS);
  assert.equal(result.status, 'dry-run');
  assert.ok(world.launchctlCalls.every(([verb]) => verb === 'print'));
  assert.ok(world.loadedLabels.has(LAUNCHD_AGENT_NAMES.HERDR_SERVER.label));
  assert.equal(world.installedPlists.size, 1);
  assert.deepEqual(world.removed, []);
});
