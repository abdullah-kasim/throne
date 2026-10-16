import assert from "node:assert/strict";
import { test } from "node:test";

import { LIVE_ROLE_WORD_UNION } from "../shared-policy/role-word-union.ts";
import { exactLabelTabs } from "./herdr-restored-tab-inspection.ts";
import type { HerdrTab } from "./herdr-inventory.service.ts";
import { repairRecipientByExactTabLabel, type RepairRecipientDeps } from "./herdr-runtime.service.ts";

const REGENT_PANE = "w1:pRegent";
const REGENT_TAB = "w1:tRegent";

function tabLabelled(label: string, tabId = REGENT_TAB): HerdrTab {
  return { tabId, label, paneCount: 1, workspaceId: "w1" };
}

function courtWithRegentTabLabelled(label: string): RepairRecipientDeps {
  return {
    listAgents: async () => [],
    listTabs: async () => [tabLabelled(label)],
    listPanes: async () => [{ paneId: REGENT_PANE, tabId: REGENT_TAB, terminalId: "terminal-regent", cwd: "/throne" }],
    getPaneProcessInfo: async (paneId) => ({ paneId, foregroundProcesses: [{ name: "bash", argv: ["-bash"] }] }),
    listRegisteredAgents: async () => ["regent"],
    readRegisteredSpawn: async () => ({ cwd: "/throne", harness: "claude" }),
    readSpawnedTabLabel: async () => "regent",
    roleWordUnion: LIVE_ROLE_WORD_UNION,
    resolvePath: (value) => value,
    readVisibleAnsi: async () => "",
    renameAgent: async () => {},
  };
}

test("a tab label matches its agent name whatever the letter case", () => {
  const tabs = [tabLabelled("regent"), tabLabelled("Regent", "w1:tOther"), tabLabelled("stager-floor", "w1:tStager")];

  assert.deepEqual(
    exactLabelTabs(tabs, "Regent").map((tab) => tab.label),
    ["regent", "Regent"],
  );
});

test("the self-repair finds the Regent's tab whether it is labelled regent or Regent", async () => {
  for (const label of ["regent", "Regent"]) {
    await assert.rejects(
      repairRecipientByExactTabLabel("Regent", [], courtWithRegentTabLabelled(label)),
      /pane has no genuine live harness process/,
    );
  }
});
