import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileBlockedAgentPages } from "../src/blocked-paging/blocked-agent-paging.hosted-worker.ts";
import { fakeBlockedAgentPagingDependencies } from "../src/blocked-paging/blocked-agent-paging-test-fixtures.ts";
import type { AgentStatusesRosterEntry } from "../src/agent-statuses/agent-statuses.types.ts";

const PERMISSION_BOX =
  " Bash command\n\n   rm -f /tmp_lintout.txt\n\n Dangerous rm operation on critical path: /tmp_lintout.txt\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n";

function rosterWith(shadow: Partial<AgentStatusesRosterEntry>): AgentStatusesRosterEntry[] {
  return [
    { name: "regent", lifecycle: "live", liveStatus: "idle", reportLanded: false, focused: false, paneId: "w1:p1" },
    { name: "alpha-x-01", lifecycle: "live", liveStatus: "done", reportLanded: false, role: "Alpha", focused: false, paneId: "w1:p2" },
    { name: "shadow-x-99b-verify", lifecycle: "live", liveStatus: "blocked", reportLanded: false, role: "Shadow", focused: false, paneId: "w1:p3", ...shadow },
  ];
}

function pagingOf(roster: AgentStatusesRosterEntry[]) {
  return fakeBlockedAgentPagingDependencies({
    now: 1_790_000_000_000,
    roster,
    supervisorOf: (name) => (name.startsWith("shadow-") ? "alpha-x-01" : "regent"),
    visiblePaneText: () => PERMISSION_BOX,
  });
}

test("a pane blocked on a permission prompt is paged from its visible screen, with the mcq line", async () => {
  const paging = pagingOf(rosterWith({}));
  await reconcileBlockedAgentPages(paging.dependencies);
  assert.equal(paging.pages.length, 1, `expected one page, got ${JSON.stringify(paging.pages)}`);
  assert.match(paging.pages[0]!, /shadow-x-99b-verify/);
  assert.match(paging.pages[0]!, /Do you want to proceed\?/);
  assert.match(paging.pages[0]!, /throne mcq --agent shadow-x-99b-verify --answer/);
});

test("a working pane is skipped and the sweep goes on to the next pane", async () => {
  const paging = pagingOf([
    ...rosterWith({ name: "shadow-x-01-busy", liveStatus: "working", paneId: "w1:p3" }),
    { name: "shadow-x-02-stuck", lifecycle: "live", liveStatus: "blocked", reportLanded: false, role: "Shadow", focused: false, paneId: "w1:p4" },
  ]);
  await reconcileBlockedAgentPages(paging.dependencies);
  assert.equal(paging.pages.length, 1);
  assert.match(paging.pages[0]!, /shadow-x-02-stuck/);
});
