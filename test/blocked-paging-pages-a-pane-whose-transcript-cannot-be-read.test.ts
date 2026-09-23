import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileBlockedAgentPages } from "../src/blocked-paging/blocked-agent-paging.hosted-worker.ts";
import type { BlockedAgentPagingDependencies } from "../src/blocked-paging/blocked-agent-paging-dependencies.types.ts";
import type { BlockedPageLedgerEntry } from "../src/blocked-paging/blocked-agent-escalation-ledger.ts";
import type { AgentStatusesRosterEntry } from "../src/agent-statuses/agent-statuses.types.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";

const PERMISSION_BOX =
  " Bash command\n\n   rm -f /tmp_lintout.txt\n\n Dangerous rm operation on critical path: /tmp_lintout.txt\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n";

function rosterWith(shadow: Partial<AgentStatusesRosterEntry>): AgentStatusesRosterEntry[] {
  return [
    { name: "regent", lifecycle: "live", liveStatus: "idle", reportLanded: false, focused: false, paneId: "w1:p1" },
    { name: "alpha-x-01", lifecycle: "live", liveStatus: "done", reportLanded: false, role: "Alpha", focused: false, paneId: "w1:p2" },
    { name: "shadow-x-99b-verify", lifecycle: "live", liveStatus: "blocked", reportLanded: false, role: "Shadow", focused: false, paneId: "w1:p3", ...shadow },
  ];
}

function dependencies(roster: AgentStatusesRosterEntry[], pages: string[], stderr: string[]): BlockedAgentPagingDependencies {
  const ledger: BlockedPageLedgerEntry[] = [];
  return {
    herdrClient: {} as never,
    listKnownPaneIds: async () => [],
    getRoster: async () => roster,
    readAgentSupervisor: async (name) => (name.startsWith("shadow-") ? "alpha-x-01" : "regent"),
    readAgent: async (name) => {
      throw new Error(`herdr agent read ${name} --lines 200 failed (agent_not_idle): cannot read 200 lines while blocked`);
    },
    readVisiblePaneText: async () => PERMISSION_BOX,
    blockedMarkerLedger: {
      readBlockedMarker: async () => null,
      writeBlockedMarker: async () => undefined,
      clearBlockedMarker: async () => undefined,
    },
    resolveAgent: async (name) => ({ name, paneId: "w1:p1" }) as HerdrAgent,
    submitToAgent: async (_target, _sender, prompt) => {
      pages.push(prompt);
    },
    sleep: async () => undefined,
    readEscalationLedger: async () => ledger,
    appendEscalationLedger: async (entry) => {
      ledger.push(entry);
    },
    notifyLord: async () => true,
    now: () => 1_790_000_000_000,
    stderr: (text) => {
      stderr.push(text);
    },
  };
}

test("a blocked pane whose transcript herdr refuses to read is paged from its visible screen, with the mcq line", async () => {
  const pages: string[] = [];
  const stderr: string[] = [];
  await reconcileBlockedAgentPages(dependencies(rosterWith({}), pages, stderr));
  assert.equal(pages.length, 1, `expected one page, got ${JSON.stringify(pages)}`);
  assert.match(pages[0]!, /shadow-x-99b-verify/);
  assert.match(pages[0]!, /Do you want to proceed\?/);
  assert.match(pages[0]!, /throne mcq --agent shadow-x-99b-verify --answer/);
  assert.equal(stderr.length, 0, `no read failure should be logged for a pane that is blocked: ${JSON.stringify(stderr)}`);
});

test("a working pane whose transcript cannot be read is skipped with a log line, and the sweep goes on to the next pane", async () => {
  const pages: string[] = [];
  const stderr: string[] = [];
  const roster = [
    ...rosterWith({ name: "shadow-x-01-busy", liveStatus: "working", paneId: "w1:p3" }),
    { name: "shadow-x-02-stuck", lifecycle: "live" as const, liveStatus: "blocked" as const, reportLanded: false, role: "Shadow", focused: false, paneId: "w1:p4" },
  ];
  await reconcileBlockedAgentPages(dependencies(roster, pages, stderr));
  assert.equal(pages.length, 1);
  assert.match(pages[0]!, /shadow-x-02-stuck/);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0]!, /shadow-x-01-busy/);
});
