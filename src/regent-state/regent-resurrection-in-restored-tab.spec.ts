import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { throneLauncherPath } from "../harness-routing/harness.ts";
import type {
  ResumeRegisteredAgentInRestoredTabDeps,
  StartOptions,
} from "../herdr/herdr-create.contracts.ts";
import type { HerdrTab } from "../herdr/herdr-inventory.service.ts";
import {
  REGENT_NAME,
  REGENT_TAB_LABEL,
  resurrectRegent,
  type ResurrectDeps,
} from "./regent-state.service.ts";

const RECORDED_SESSION_ID = "0f6f2a51-7c1e-4d0b-9a55-3f1f5f0c2b9e";
const RESTORED_TAB_ID = "tab-regent";
const RESTORED_PANE_ID = "pane-regent";
const RESUME_FLAG = "--resume";

interface PaneLaunch {
  name: string;
  paneId: string;
  argv: string[];
}

interface FakeCourt {
  deps: ResurrectDeps;
  paneLaunches: PaneLaunch[];
  newTabNames: string[];
  openingPromptRecipients: string[];
}

interface CourtShape {
  tabLabels: string[];
  recordedSessionId?: string;
  recordedSessionCanBeResumed?: boolean;
}

async function regentDirWithSpawnRecord(
  sessionId: string | undefined,
): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "throne-regent-data-"));
  const regentDir = path.join(dataDir, "regent");
  await mkdir(regentDir);
  await writeFile(
    path.join(regentDir, "spawn.json"),
    JSON.stringify({
      harness: "claude",
      model: "opus",
      effort: 2,
      cwd: dataDir,
      session_id: sessionId,
    }),
  );
  return regentDir;
}

async function courtAfterReboot(shape: CourtShape): Promise<FakeCourt> {
  const paneLaunches: PaneLaunch[] = [];
  const newTabNames: string[] = [];
  const openingPromptRecipients: string[] = [];
  const tabs: HerdrTab[] = shape.tabLabels.map((label, index) => ({
    tabId: index === 0 ? RESTORED_TAB_ID : `tab-${index}`,
    label,
    paneCount: 1,
    workspaceId: "workspace",
  }));
  const restoredTab: ResumeRegisteredAgentInRestoredTabDeps = {
    listTabs: async () => tabs,
    listPanes: async () =>
      tabs.map((tab, index) => ({
        paneId: index === 0 ? RESTORED_PANE_ID : `pane-${index}`,
        tabId: tab.tabId,
        terminalId: `terminal-${index}`,
      })),
    listNameOwners: async () => [],
    getPaneProcessInfo: async (paneId) => ({
      paneId,
      foregroundProcesses: [{ name: "bash", argv: ["-bash"] }],
    }),
    renameAgent: async () => {},
    startInTab: async (name: string, paneId: string, opts: StartOptions) => {
      paneLaunches.push({ name, paneId, argv: opts.argv });
      if (
        opts.argv.includes(RESUME_FLAG) &&
        shape.recordedSessionCanBeResumed === false
      ) {
        throw new Error("No conversation found with that session id");
      }
      return paneId;
    },
    startAgent: async (name) => {
      newTabNames.push(name);
      return {} as Awaited<ReturnType<ResurrectDeps["startAgent"]>>;
    },
    closePane: async () => {},
    sleep: async () => {},
  };
  const deps: ResurrectDeps = {
    startAgent: restoredTab.startAgent,
    deliverOpeningPrompt: async (name) => {
      openingPromptRecipients.push(name);
    },
    readRegentHarness: async () => "claude",
    readRegentRoute: async () => undefined,
    configuredRegentLaunch: () => undefined,
    findLiveRegent: async () => null,
    installHerdrOperatorSkill: async (role) => ({
      kind: "not-an-operator-role",
      role,
    }),
    restoredTab,
    writeStderr: () => {},
    throneRoot: "/throne",
    regentDir: await regentDirWithSpawnRecord(shape.recordedSessionId),
    spawnMarkerWindowMs: 0,
  };
  return { deps, paneLaunches, newTabNames, openingPromptRecipients };
}

test("a resurrected Regent comes back in its restored tab and resumes its recorded session", async () => {
  const court = await courtAfterReboot({
    tabLabels: [REGENT_TAB_LABEL, "stager-floor"],
    recordedSessionId: RECORDED_SESSION_ID,
  });

  await resurrectRegent(court.deps);

  assert.equal(court.paneLaunches.length, 1);
  const [launch] = court.paneLaunches;
  assert.equal(launch!.paneId, RESTORED_PANE_ID);
  assert.equal(launch!.argv[0], throneLauncherPath("claudey"));
  assert.deepEqual(launch!.argv.slice(-2), [RESUME_FLAG, RECORDED_SESSION_ID]);
  assert.deepEqual(court.openingPromptRecipients, [REGENT_NAME]);
});

test("a resurrected Regent opens no second tab when its restored tab exists", async () => {
  const court = await courtAfterReboot({
    tabLabels: [REGENT_TAB_LABEL],
    recordedSessionId: RECORDED_SESSION_ID,
  });

  await resurrectRegent(court.deps);

  assert.deepEqual(court.newTabNames, []);
});

test("a resurrected Regent starts in a new tab when no restored tab exists", async () => {
  const court = await courtAfterReboot({
    tabLabels: ["stager-floor"],
    recordedSessionId: RECORDED_SESSION_ID,
  });

  await resurrectRegent(court.deps);

  assert.deepEqual(court.newTabNames, [REGENT_NAME]);
  assert.deepEqual(court.paneLaunches, []);
  assert.deepEqual(court.openingPromptRecipients, [REGENT_NAME]);
});

test("a resurrected Regent starts a fresh session in its restored tab when the recorded session cannot be resumed", async () => {
  const unresumable = await courtAfterReboot({
    tabLabels: [REGENT_TAB_LABEL],
    recordedSessionId: RECORDED_SESSION_ID,
    recordedSessionCanBeResumed: false,
  });
  const neverRecorded = await courtAfterReboot({
    tabLabels: [REGENT_TAB_LABEL],
  });

  await resurrectRegent(unresumable.deps);
  await resurrectRegent(neverRecorded.deps);

  assert.equal(unresumable.paneLaunches.length, 2);
  for (const court of [unresumable, neverRecorded]) {
    const freshLaunch = court.paneLaunches.at(-1)!;
    assert.equal(freshLaunch.paneId, RESTORED_PANE_ID);
    assert.equal(freshLaunch.argv[0], throneLauncherPath("claudey"));
    assert.equal(freshLaunch.argv.includes(RESUME_FLAG), false);
    assert.deepEqual(court.newTabNames, []);
    assert.deepEqual(court.openingPromptRecipients, [REGENT_NAME]);
  }
  assert.equal(neverRecorded.paneLaunches.length, 1);
});
