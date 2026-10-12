import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  HerdrForegroundProcess,
  HerdrTab,
} from "./herdr-inventory.service.ts";
import {
  findRestoredAgentTab,
  type RestoredAgentTabDeps,
} from "./restored-agent-tab.ts";

const AGENT_NAME = "stager-floor";
const BARE_SHELL: HerdrForegroundProcess = { name: "bash", argv: ["-bash"] };
const CLAUDE_HARNESS: HerdrForegroundProcess = {
  name: "claude",
  argv: ["claude"],
};

interface FakeTab {
  tabId: string;
  label: string;
  paneId: string;
  foregroundProcess: HerdrForegroundProcess;
}

function restoredShellTab(tabId: string, label: string): FakeTab {
  return {
    tabId,
    label,
    paneId: `${tabId}-pane`,
    foregroundProcess: BARE_SHELL,
  };
}

function herdrWithTabs(tabs: FakeTab[]): RestoredAgentTabDeps {
  return {
    listTabs: async (): Promise<HerdrTab[]> =>
      tabs.map(({ tabId, label }) => ({
        tabId,
        label,
        paneCount: 1,
        workspaceId: "workspace",
      })),
    listPanes: async () =>
      tabs.map(({ tabId, paneId }) => ({
        paneId,
        tabId,
        terminalId: `${paneId}-terminal`,
      })),
    getPaneProcessInfo: async (paneId) => ({
      paneId,
      foregroundProcesses: tabs
        .filter((tab) => tab.paneId === paneId)
        .map((tab) => tab.foregroundProcess),
    }),
  };
}

test("a restored tab is found when exactly one tab carries the agent's name and its pane runs no harness", async () => {
  const herdr = herdrWithTabs([
    restoredShellTab("tab-other", "another-agent"),
    restoredShellTab("tab-agent", AGENT_NAME),
  ]);

  assert.deepEqual(await findRestoredAgentTab(AGENT_NAME, herdr), {
    tabId: "tab-agent",
    paneId: "tab-agent-pane",
  });
});

test("no restored tab is found when no tab carries the agent's name", async () => {
  const herdr = herdrWithTabs([
    restoredShellTab("tab-other", "another-agent"),
  ]);

  assert.equal(await findRestoredAgentTab(AGENT_NAME, herdr), null);
});

test("no restored tab is found when more than one tab carries the agent's name", async () => {
  const herdr = herdrWithTabs([
    restoredShellTab("tab-first", AGENT_NAME),
    restoredShellTab("tab-second", AGENT_NAME),
  ]);

  assert.equal(await findRestoredAgentTab(AGENT_NAME, herdr), null);
});

test("no restored tab is found when the pane already runs a harness", async () => {
  const herdr = herdrWithTabs([
    {
      ...restoredShellTab("tab-agent", AGENT_NAME),
      foregroundProcess: CLAUDE_HARNESS,
    },
  ]);

  assert.equal(await findRestoredAgentTab(AGENT_NAME, herdr), null);
});

test("a tab whose label only contains the agent's name is not a restored tab for it", async () => {
  const herdr = herdrWithTabs([
    restoredShellTab("tab-renamed", `stale-${AGENT_NAME}`),
  ]);

  assert.equal(await findRestoredAgentTab(AGENT_NAME, herdr), null);
});
