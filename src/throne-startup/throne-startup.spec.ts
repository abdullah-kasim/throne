import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  LIVE_QUEUE_ITEM_STATUSES,
  renderRegentQueueAsMarkdown,
} from "../regent-queue/regent-queue-render.ts";
import { RegentQueueItemStatus } from "../regent-queue/regent-queue-item-state.ts";
import type { RegentQueueItemRow, RegentQueueReadResult } from "../regent-queue/regent-queue.store.ts";
import { resolveDigestReader, type DigestReader } from "./throne-startup-queue-digest.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { MOVED_NOTE_FILE_NAME } from "../migrate-home/migrate-home.ts";
import { retiredBrowserProfilesDirectory } from "../migrate-home/migrate-home-items.ts";
import { retiredSettingsDirectory, throneConfigDirectory } from "../shared-policy/throne-home.ts";
import { THRONE_HERDR_SESSION_NAME } from "../herdr/herdr-client.ts";
import type { HerdrAgent, HerdrTab } from "../herdr/herdr-inventory.service.ts";
import { DESIRED_STATES, REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { REAL_DEPS, copyOldInstallIntoThroneHome, run, type ThroneStartupDeps } from "./throne-startup.ts";

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
    listTabs: async () => [],
    renameWorkspace: async () => {},
    throneRoot: THRONE_ROOT,
    readQueue: async () => ({ state: "positively-empty" as const }),
    resolveDigestReader: async () => ({ kind: "whole-queue" as const }),
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

const unnamedSession = { ...regentSession, name: undefined } as HerdrAgent;

function unnamedSessionStartLaunchedAs(agentNameAtLaunch: string | undefined) {
  const agentRenames: string[][] = [];
  const tabRenames: string[][] = [];
  const startup = regentSessionStartWith({
    listAgents: async () => [unnamedSession],
    agentNameAtLaunch: () => agentNameAtLaunch,
    renameAgent: async (paneId: string, name: string) => {
      agentRenames.push([paneId, name]);
    },
    renameTab: async (tabId: string, label: string) => {
      tabRenames.push([tabId, label]);
    },
  });
  return { ...startup, agentRenames, tabRenames };
}

test("a harness launched as another agent never takes the Regent's name while the Regent is down", async () => {
  const startup = unnamedSessionStartLaunchedAs("stager-pantry");

  const exitCode = await run([], startup.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(startup.agentRenames, []);
  assert.deepEqual(startup.tabRenames, []);
  assert.deepEqual(startup.reconciledRosters, []);
});

test("a Regent resurrected with no name still takes its name and reconciles", async () => {
  for (const launchedAs of [undefined, "", "regent", REGENT_NAME]) {
    const startup = unnamedSessionStartLaunchedAs(launchedAs);

    const exitCode = await run([], startup.deps);

    assert.equal(exitCode, 0);
    assert.deepEqual(startup.agentRenames, [[REGENT_PANE_ID, REGENT_NAME]]);
    assert.equal(startup.tabRenames.length, 1);
    assert.deepEqual(startup.reconciledRosters, [[unnamedSession]]);
  }
});

test("the name a harness was launched as is read from the variable its launch exports", (t) => {
  const earlierName = process.env.THRONE_AGENT_NAME;
  t.after(() => {
    if (earlierName === undefined) delete process.env.THRONE_AGENT_NAME;
    else process.env.THRONE_AGENT_NAME = earlierName;
  });
  process.env.THRONE_AGENT_NAME = "stager-pantry";
  assert.equal(REAL_DEPS.agentNameAtLaunch?.(), "stager-pantry");
});

function tabInWorkspace(tabId: string, workspaceId: string): HerdrTab {
  return { tabId, label: tabId, paneCount: 1, workspaceId };
}

test("a booting Regent renames its own workspace to throne", async () => {
  const workspaceRenames: string[][] = [];
  const startup = regentSessionStartWith({
    listTabs: async () => [
      tabInWorkspace("another-tab", "another-workspace"),
      tabInWorkspace(regentSession.tabId, "regent-workspace"),
    ],
    renameWorkspace: async (workspaceId: string, label: string) => {
      workspaceRenames.push([workspaceId, label]);
    },
  });

  const exitCode = await run([], startup.deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(workspaceRenames, [["regent-workspace", THRONE_HERDR_SESSION_NAME]]);
});

test("a failing workspace rename is reported on stderr and startup continues", async (t) => {
  const stderrWrite = t.mock.method(process.stderr, "write", () => true);
  const startup = regentSessionStartWith({
    listTabs: async () => [tabInWorkspace(regentSession.tabId, "regent-workspace")],
    renameWorkspace: async () => {
      throw new Error("herdr refused the rename");
    },
  });

  const exitCode = await run([], startup.deps);

  const stderrText = stderrWrite.mock.calls.map((call) => String(call.arguments[0])).join("");
  assert.equal(exitCode, 0);
  assert.match(stderrText, /workspace rename .* failed \(herdr refused the rename\); continuing/);
  assert.deepEqual(startup.reconciledRosters, [[regentSession]]);
});

test("a tab with no workspace id renames nothing", async () => {
  let workspaceRenames = 0;
  const startup = regentSessionStartWith({
    listTabs: async () => [tabInWorkspace(regentSession.tabId, "")],
    renameWorkspace: async () => {
      workspaceRenames += 1;
    },
  });

  const exitCode = await run([], startup.deps);

  assert.equal(exitCode, 0);
  assert.equal(workspaceRenames, 0);
  assert.deepEqual(startup.reconciledRosters, [[regentSession]]);
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
  await writeFile(path.join(retiredSettingsDirectory(userHome), "private-refs.txt"), "old\n");
  await writeFile(path.join(throneConfigDirectory(environment), "private-refs.txt"), "new\n");
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
  const oldSettings = path.join(retiredSettingsDirectory(install.userHome), "private-refs.txt");
  await writeFile(oldSettings, "old install\n");

  await startRegentSessionCopyingFrom(install);

  assert.equal(await readFile(path.join(throneConfigDirectory(install.environment), "private-refs.txt"), "utf8"), "old install\n");
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

const LIVE_QUEUE: RegentQueueReadResult = {
  state: "items",
  items: [
    queueRow("crumbcake", RegentQueueItemStatus.InFlight, "alpha-crumbcake-01", "full body of crumbcake"),
    queueRow("ryeloaf", RegentQueueItemStatus.Open, null, "full body of ryeloaf"),
    queueRow("scone", RegentQueueItemStatus.Deferred, null, "full body of scone"),
    queueRow("landed", RegentQueueItemStatus.Complete, null, "full body of landed"),
  ],
};

function queueRow(
  objectiveCode: string,
  status: RegentQueueItemStatus,
  agentName: string | null,
  body: string,
): RegentQueueItemRow {
  return {
    id: `id-${objectiveCode}`,
    objectiveCode,
    status,
    body,
    prBranch: "main",
    agentName,
    targetRepo: "/repos/throne",
    baseCommit: null,
    deliveryCommit: null,
    deliveryMirror: null,
    absorption: null,
    deferral: null,
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as RegentQueueItemRow;
}

function todaysDigest(): string {
  return `throne-startup: QUEUE digest\n\n${renderRegentQueueAsMarkdown(LIVE_QUEUE, { statuses: LIVE_QUEUE_ITEM_STATUSES })}`;
}

async function dataDirectoryWith(identities: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "startup-digest-"));
  for (const [name, lines] of Object.entries(identities)) {
    await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, name, "identity.md"), `# Identity — ${name}\n\n${lines}\n`);
  }
  return directory;
}

async function startupDigestFor(
  t: TestContext,
  sessionName: string,
  resolveReader: (name: string | undefined) => Promise<DigestReader>,
): Promise<string> {
  const session = { ...regentSession, name: sessionName } as HerdrAgent;
  const { deps } = regentSessionStartWith({
    listAgents: async () => [session],
    readQueue: async () => LIVE_QUEUE,
    resolveDigestReader: resolveReader,
    reconcile: undefined,
  });
  const written: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  await run([], deps);
  t.mock.restoreAll();
  const digest = written.find((chunk) => chunk.startsWith("throne-startup: QUEUE digest"));
  assert.ok(digest !== undefined, "the hook printed no queue digest");
  return digest;
}

const IDENTITIES = {
  "alpha-crumbcake-01": "- **Role:** Alpha\n- **Campaign objective code:** crumbcake",
  "shadow-crumbcake-01-x": "- **Role:** Shadow\n- **Campaign objective code:** crumbcake",
  "alpha-gone-01": "- **Role:** Alpha\n- **Campaign objective code:** gone",
  "stager-floor": "- **Role:** Stager",
};

async function digestForRegisteredAgent(t: TestContext, name: string): Promise<string> {
  const directory = await dataDirectoryWith(IDENTITIES);
  return startupDigestFor(t, name, (readerName) => resolveDigestReader(readerName, directory));
}

test("the Regent's startup digest is byte-identical to today's for the same queue", async (t) => {
  assert.equal(await digestForRegisteredAgent(t, REGENT_NAME), todaysDigest());
});

test("an agent with no registered identity still gets the full queue digest", async (t) => {
  assert.equal(await digestForRegisteredAgent(t, "nobody-registered"), todaysDigest());
});

test("an Alpha's startup digest shows only its own row then the count of the others", async (t) => {
  const digest = await digestForRegisteredAgent(t, "alpha-crumbcake-01");
  assert.match(digest, /full body of crumbcake/);
  assert.doesNotMatch(digest, /full body of ryeloaf|full body of scone|ryeloaf/);
  assert.ok(digest.endsWith("2 other live rows; `throne render-queue` shows them\n"));
});

test("a Shadow's startup digest shows only its campaign's row then the count of the others", async (t) => {
  const digest = await digestForRegisteredAgent(t, "shadow-crumbcake-01-x");
  assert.match(digest, /full body of crumbcake/);
  assert.doesNotMatch(digest, /ryeloaf|scone/);
  assert.ok(digest.endsWith("2 other live rows; `throne render-queue` shows them\n"));
});

test("an Alpha whose objective has no live row gets only the one-line pointer", async (t) => {
  assert.equal(
    await digestForRegisteredAgent(t, "alpha-gone-01"),
    "throne-startup: QUEUE digest\n\n3 other live rows; `throne render-queue` shows them\n",
  );
});

test("a Stager's startup digest lists one line per live row without bodies", async (t) => {
  assert.equal(
    await digestForRegisteredAgent(t, "stager-floor"),
    "throne-startup: QUEUE digest\n\n" +
      "- crumbcake (in-flight), agent: alpha-crumbcake-01, repository: /repos/throne\n" +
      "- ryeloaf (open), agent: none, repository: /repos/throne\n" +
      "- scone (deferred), agent: none, repository: /repos/throne\n\n" +
      "3 other live rows; `throne render-queue` shows them\n",
  );
});

test("a failure working out the role falls back to the full queue digest", async (t) => {
  const digest = await startupDigestFor(t, "stager-floor", async () => {
    throw new Error("identity ledger unreadable");
  });
  assert.equal(digest, todaysDigest());
});
