import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { MOVED_NOTE_FILE_NAME } from "../migrate-home/migrate-home.ts";
import { retiredBrowserProfilesDirectory } from "../migrate-home/migrate-home-items.ts";
import { retiredSettingsDirectory, throneConfigDirectory } from "../shared-policy/throne-home.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { DESIRED_STATES, REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { copyOldInstallIntoThroneHome, run, type ThroneStartupDeps } from "./throne-startup.ts";

const THRONE_ROOT = "/court/throne";
const REGENT_PANE_ID = "regent-pane";

const regentSession = {
  paneId: REGENT_PANE_ID,
  tabId: "regent-tab",
  name: REGENT_NAME,
  cwd: THRONE_ROOT,
} as HerdrAgent;

interface RegentSessionStart {
  readonly deps: ThroneStartupDeps;
  readonly reconciledRosters: HerdrAgent[][];
}

function regentSessionStartWith(extraDeps: Record<string, unknown>): RegentSessionStart {
  const reconciledRosters: HerdrAgent[][] = [];
  const deps = {
    currentPaneId: async () => REGENT_PANE_ID,
    listAgents: async () => [regentSession],
    renameAgent: async () => {},
    renameTab: async () => {},
    throneRoot: THRONE_ROOT,
    installOmpExtension: async () => ({ kind: "already-installed" as const, target: "/x" }),
    renderQueueDigest: async () => "",
    readDesiredState: async () => DESIRED_STATES.RUNNING,
    reconcile: async (liveAgents: HerdrAgent[]) => {
      reconciledRosters.push(liveAgents);
    },
    ...extraDeps,
  } as unknown as ThroneStartupDeps;
  return { deps, reconciledRosters };
}

test("starting a Regent session no longer raises the Stager, and still reconciles", async () => {
  let stagerRaises = 0;
  const startup = regentSessionStartWith({
    ensureStagerFloor: async () => {
      stagerRaises += 1;
    },
  });

  const exitCode = await run([], startup.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(startup.reconciledRosters, [[regentSession]]);
  assert.equal(stagerRaises, 0);
});

interface MigratingStartup extends RegentSessionStart {
  readonly migrationExitCodes: number[];
}

function regentSessionStartThatMigrates(migrateHome: () => Promise<number>): MigratingStartup {
  const migrationExitCodes: number[] = [];
  const startup = regentSessionStartWith({
    migrateHome: async () => {
      const exitCode = await migrateHome();
      migrationExitCodes.push(exitCode);
      return exitCode;
    },
  });
  return { ...startup, migrationExitCodes };
}

interface OldInstall {
  readonly userHome: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function makeOldInstall(): Promise<OldInstall> {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-migrate-home-"));
  const userHome = path.join(root, "user");
  const environment = { THRONE_DATA_HOME: path.join(root, "throne-home") };
  await mkdir(retiredSettingsDirectory(userHome), { recursive: true });
  return { userHome, environment };
}

test("a refused migration never stops throne startup", async () => {
  const { userHome, environment } = await makeOldInstall();
  await mkdir(throneConfigDirectory(environment), { recursive: true });
  await writeFile(path.join(retiredSettingsDirectory(userHome), "features.json"), "old\n");
  await writeFile(path.join(throneConfigDirectory(environment), "features.json"), "new\n");
  const startup = regentSessionStartThatMigrates(() => copyOldInstallIntoThroneHome(environment, userHome));

  const exitCode = await run([], startup.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(startup.migrationExitCodes, [1]);
  assert.deepEqual(startup.reconciledRosters, [[regentSession]]);
});

async function startRegentSessionCopyingFrom(install: OldInstall): Promise<void> {
  const startup = regentSessionStartThatMigrates(() =>
    copyOldInstallIntoThroneHome(install.environment, install.userHome),
  );
  assert.equal(await run([], startup.deps), 0);
  assert.deepEqual(startup.migrationExitCodes, [0]);
}

function hasMovedNote(oldFolder: string): Promise<boolean> {
  return pathExists(path.join(oldFolder, MOVED_NOTE_FILE_NAME));
}

test("throne startup copies an old install's settings into the throne home and leaves the old files in place", async () => {
  const install = await makeOldInstall();
  const oldSettings = path.join(retiredSettingsDirectory(install.userHome), "features.json");
  await writeFile(oldSettings, "old install\n");

  await startRegentSessionCopyingFrom(install);

  assert.equal(await readFile(path.join(throneConfigDirectory(install.environment), "features.json"), "utf8"), "old install\n");
  assert.equal(await readFile(oldSettings, "utf8"), "old install\n");
  assert.equal(await hasMovedNote(retiredSettingsDirectory(install.userHome)), false);
});

test("throne startup never moves a browser profile", async () => {
  const install = await makeOldInstall();
  const oldProfile = path.join(retiredBrowserProfilesDirectory(install.userHome), "example-host");
  await mkdir(oldProfile, { recursive: true });
  await writeFile(path.join(oldProfile, "Cookies"), "signed in\n");

  await startRegentSessionCopyingFrom(install);

  assert.equal(await readFile(path.join(oldProfile, "Cookies"), "utf8"), "signed in\n");
  assert.equal(await hasMovedNote(retiredBrowserProfilesDirectory(install.userHome)), false);
});
