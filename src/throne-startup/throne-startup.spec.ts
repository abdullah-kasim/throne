import assert from "node:assert/strict";
import { test } from "node:test";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { DESIRED_STATES, REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { run, type ThroneStartupDeps } from "./throne-startup.ts";

const THRONE_ROOT = "/court/throne";
const REGENT_PANE_ID = "regent-pane";

const regentSession = {
  paneId: REGENT_PANE_ID,
  tabId: "regent-tab",
  name: REGENT_NAME,
  cwd: THRONE_ROOT,
} as HerdrAgent;

test("starting a Regent session no longer raises the Stager, and still reconciles", async () => {
  const reconciledRosters: HerdrAgent[][] = [];
  let stagerRaises = 0;
  const regentSessionStart = {
    currentPaneId: async () => REGENT_PANE_ID,
    listAgents: async () => [regentSession],
    renameAgent: async () => {},
    renameTab: async () => {},
    throneRoot: THRONE_ROOT,
    installOmpExtension: async () => ({
      kind: "already-installed" as const,
      target: "/x",
    }),
    renderQueueDigest: async () => "",
    readDesiredState: async () => DESIRED_STATES.RUNNING,
    reconcile: async (liveAgents: HerdrAgent[]) => {
      reconciledRosters.push(liveAgents);
    },
    ensureStagerFloor: async () => {
      stagerRaises += 1;
    },
  } as unknown as ThroneStartupDeps;

  const exitCode = await run([], regentSessionStart);

  assert.equal(exitCode, 0);
  assert.deepEqual(reconciledRosters, [[regentSession]]);
  assert.equal(stagerRaises, 0);
});
