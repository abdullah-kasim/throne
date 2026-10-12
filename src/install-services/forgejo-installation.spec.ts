import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { makeScratchDirectory } from '../scratch-directory.test-support.ts';

import { forgejoStateDirectory } from './forgejo-installation.ts';
import { installServices } from './install-services.ts';
import type { InstallServicesDeps, InstallServicesResult } from './install-services.types.ts';
import { withInstallServicesOutput } from './output.ts';
import { REAL_DEPS } from './platform.ts';
import {
  LAUNCH_AGENTS_DIR,
  LAUNCHD_AGENT_NAMES,
  SYSTEMD_UNIT_NAMES,
  USER_UNIT_DIR,
  type InstalledUnit,
  type ServiceCommandResult,
} from './service-unit-renderer.service.ts';

const MAC_USER_ID = 501;
const FORGEJO_UNIT = SYSTEMD_UNIT_NAMES.FORGEJO;
const FORGEJO_AGENT = LAUNCHD_AGENT_NAMES.FORGEJO;

interface FakeHost {
  throneRoot: string;
  installedFiles: Map<string, string>;
  systemctlCalls: string[][];
  launchctlCalls: string[][];
  deps: InstallServicesDeps;
}

function succeeded(code = 0): ServiceCommandResult {
  return { code, stdout: '', stderr: '' };
}

async function makeFakeHost(
  platform: 'linux' | 'darwin',
  forgejoInstalled: boolean,
): Promise<FakeHost> {
  const home = await makeScratchDirectory('forgejo-install-home-');
  const throneRoot = await makeScratchDirectory('forgejo-install-throne-');
  const installedFiles = new Map<string, string>();
  const systemctlCalls: string[][] = [];
  const launchctlCalls: string[][] = [];
  const runningUnits = new Set<string>();
  const loadedLabels = new Set<string>();
  const deps: InstallServicesDeps = {
    platform,
    arch: 'x64',
    userId: () => MAC_USER_ID,
    systemctl: async (args) => {
      systemctlCalls.push(args);
      const verb = args[1];
      const unit = args.at(-1) ?? '';
      if (verb === 'is-active' || verb === 'is-enabled') {
        return succeeded(runningUnits.has(unit) ? 0 : 3);
      }
      if (verb === 'enable') {
        runningUnits.add(unit);
      }
      return succeeded();
    },
    launchctl: async (args) => {
      launchctlCalls.push(args);
      const [verb, target] = args;
      if (verb === 'print') {
        return succeeded(loadedLabels.has(target?.split('/').pop() ?? '') ? 0 : 113);
      }
      if (verb === 'bootstrap') {
        loadedLabels.add(path.basename(args[2], '.plist'));
      }
      return succeeded();
    },
    readUnitSource: REAL_DEPS.readUnitSource,
    inspectInstalledUnit: async (targetPath): Promise<InstalledUnit> => {
      const content = installedFiles.get(targetPath);
      return content === undefined ? { kind: 'missing', content: '' } : { kind: 'file', content };
    },
    writeUnitFile: async (targetPath, content) => {
      installedFiles.set(targetPath, content);
    },
    removeUnitFile: async (targetPath) => {
      installedFiles.delete(targetPath);
    },
    resolveNodeBin: () => '/srv/mise/node/24.19.0/bin/node',
    ownedHerdrPath: () => '/srv/herdr/herdr',
    herdrCacheDirectory: () => '/srv/cache',
    installHerdr: async (options) => ({
      target: 'linux-x86_64',
      source: 'installed',
      installPath: options.installPath,
    }),
    throneCommandPath: () => '/srv/bin/throne',
    inspectThroneCommand: async () => ({ kind: 'missing' }),
    createThroneCommandSymlink: async () => {},
    pathSymlinkTargets: () => [],
    inspectPathSymlink: async () => ({ kind: 'missing' }),
    writePathSymlink: async () => {},
    claudeSettingsPath: () => '/srv/claude/settings.json',
    readClaudeSettings: async () => null,
    writeClaudeSettings: async () => {},
    herdrConfigPath: () => path.join(home, '.config', 'herdr', 'config.toml'),
    bashrcPath: () => path.join(home, '.bashrc'),
    isForgejoInstalled: async () => forgejoInstalled,
  };
  return { throneRoot, installedFiles, systemctlCalls, launchctlCalls, deps };
}

async function runInstallServices(host: FakeHost): Promise<InstallServicesResult> {
  return withInstallServicesOutput(
    { writeLine: () => {}, writeError: () => {} },
    () =>
      installServices(
        { dryRun: false, throneRoot: host.throneRoot, throneRootExplicit: true },
        host.deps,
      ),
  );
}

function callsNaming(calls: string[][], name: string): string[][] {
  return calls.filter((args) => args.some((arg) => arg.includes(name)));
}

test('a plain install-services run on a host that never installed Forgejo leaves Forgejo uninstalled and never enables or starts it', async () => {
  const host = await makeFakeHost('linux', false);
  const result = await runInstallServices(host);
  assert.equal(result.code, 0);
  assert.ok(host.installedFiles.has(path.join(USER_UNIT_DIR, SYSTEMD_UNIT_NAMES.NTFY)));
  assert.ok(!host.installedFiles.has(path.join(USER_UNIT_DIR, FORGEJO_UNIT)));
  assert.deepEqual(callsNaming(host.systemctlCalls, 'forgejo'), []);
});

test('a plain install-services run on a Mac that never installed Forgejo writes no Forgejo plist and bootstraps none', async () => {
  const host = await makeFakeHost('darwin', false);
  const result = await runInstallServices(host);
  assert.equal(result.code, 0);
  assert.ok(host.installedFiles.has(path.join(LAUNCH_AGENTS_DIR, LAUNCHD_AGENT_NAMES.NTFY.basename)));
  assert.ok(!host.installedFiles.has(path.join(LAUNCH_AGENTS_DIR, FORGEJO_AGENT.basename)));
  assert.deepEqual(callsNaming(host.launchctlCalls, 'forgejo'), []);
});

test('a host where the Forgejo installer ran gets forgejo.service rendered and enabled-and-started', async () => {
  const host = await makeFakeHost('linux', true);
  const result = await runInstallServices(host);
  assert.equal(result.code, 0);
  const renderedUnit = host.installedFiles.get(path.join(USER_UNIT_DIR, FORGEJO_UNIT));
  assert.ok(renderedUnit?.includes(`\nExecStart=${host.throneRoot}/systemd/forgejo-serve\n`));
  assert.deepEqual(
    callsNaming(host.systemctlCalls, 'forgejo').filter(([, verb]) => verb === 'enable'),
    [['--user', 'enable', '--now', FORGEJO_UNIT]],
  );
});

test('a Mac where the Forgejo installer ran gets com.throne.forgejo rendered and bootstrapped', async () => {
  const host = await makeFakeHost('darwin', true);
  const result = await runInstallServices(host);
  assert.equal(result.code, 0);
  const plistPath = path.join(LAUNCH_AGENTS_DIR, FORGEJO_AGENT.basename);
  const renderedPlist = host.installedFiles.get(plistPath);
  assert.ok(renderedPlist?.includes(`<string>${FORGEJO_AGENT.label}</string>`));
  assert.ok(renderedPlist?.includes(`exec ${host.throneRoot}/systemd/forgejo-serve `));
  assert.deepEqual(
    callsNaming(host.launchctlCalls, 'forgejo').filter(([verb]) => verb !== 'print'),
    [
      ['enable', `gui/${MAC_USER_ID}/${FORGEJO_AGENT.label}`],
      ['bootstrap', `gui/${MAC_USER_ID}`, plistPath],
    ],
  );
});

test('the macOS Forgejo service runs the node version pinned in mise.toml', async () => {
  const host = await makeFakeHost('darwin', true);
  const result = await runInstallServices(host);
  assert.equal(result.code, 0);
  const renderedPlist = host.installedFiles.get(path.join(LAUNCH_AGENTS_DIR, FORGEJO_AGENT.basename));
  const forgejoNodeBin = /<key>FORGEJO_NODE_BIN<\/key>\s*<string>([^<]*)<\/string>/.exec(renderedPlist ?? '')?.[1];
  assert.equal(forgejoNodeBin, host.deps.resolveNodeBin(host.throneRoot));
});

test("install-services counts Forgejo as installed exactly when the installer's enabled marker sits in Forgejo's state directory", async (context) => {
  const stateHome = await makeScratchDirectory('forgejo-state-home-');
  const stateHomeBefore = process.env.XDG_STATE_HOME;
  context.after(() => {
    if (stateHomeBefore === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = stateHomeBefore;
    }
  });
  process.env.XDG_STATE_HOME = stateHome;
  assert.equal(forgejoStateDirectory(), path.join(stateHome, 'forgejo'));
  await mkdir(forgejoStateDirectory(), { recursive: true });
  assert.equal(await REAL_DEPS.isForgejoInstalled(), false);
  await writeFile(path.join(stateHome, 'forgejo', 'enabled'), '');
  assert.equal(await REAL_DEPS.isForgejoInstalled(), true);
});
