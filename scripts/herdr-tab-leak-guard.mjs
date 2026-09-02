import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listTabs, listNameOwners } from "../src/herdr/herdr-runtime.service.ts";
import { resolveThroneHerdrSessionName } from "../src/herdr/herdr-client.ts";

// This guard measures the court's tab set across the `npm test` invocation
// and can be contaminated by concurrent `create-agent`/`reap-agent` activity
// from other terminals during that window — see
// SPAWNING_AN_AGENT_CONTAMINATES_A_RUNNING_SUITE in the agent memory docs.
// That is an accepted, already-documented limitation of any before/after
// court measurement in this codebase, not a gap this guard tries to close.
// A suite that sets THRONE_HERDR_SESSION_NAME_OVERRIDE to its own isolated
// session is immune to it by construction: listTabs()/listNameOwners()
// already route to that session alone (resolveThroneHerdrSessionName is the
// one session-selection seam every herdr command shares), so no concurrent
// court activity or sibling suite is even visible to this diff.

// Keyed on the resolved session name so two suites running under different
// `THRONE_HERDR_SESSION_NAME_OVERRIDE` values never clobber each other's
// pretest/posttest snapshot file on the shared tmp filesystem.
const SNAPSHOT_PATH = path.join(
  tmpdir(),
  `throne-herdr-tab-leak-guard-snapshot-${resolveThroneHerdrSessionName()}.json`,
);

/**
 * Residue is defined as "present after this run but absent from this run's
 * own before-snapshot," keyed on tab ID ALONE. A tab that existed before the
 * run — the Regent's tab, a sibling campaign Alpha/Shadow's tab, the Lord's
 * plain numeric shell tabs — is excluded by construction, and a label rename
 * of a pre-existing tab (e.g. the sibling PSW campaign's persona-switch
 * rename) is invisible to this diff because the ID it keys on never changed.
 * The label is carried on each residual entry only to make the failure
 * message readable; it never participates in the equality test.
 *
 * Agent spawning is not atomic: `startAgent` creates the herdr tab first,
 * then only once the harness process is detected does herdr rename the pane
 * into an addressable named entry (`herdr agent list` / `listNameOwners()`).
 * A tab created by a legitimate concurrent spawn during the test window is
 * therefore briefly unaddressable — exactly like this guard's own founding
 * true-positive case, a leaked orphan pane a botched reap left alive. The
 * difference is durable: by the time `posttest` runs, a legitimate spawn has
 * finished registering and IS addressable, while a genuinely orphaned pane
 * never becomes addressable at all. `ownedTabIds` — the current name-owner
 * set — lets a residual tab that is now addressable clear itself; a residual
 * tab absent from it is reported exactly as before.
 */
export function findResidualTabs(beforeSnapshot, afterSnapshot, ownedTabIds = []) {
  const beforeIds = new Set(beforeSnapshot.map((tab) => tab.tabId));
  const owned = new Set(ownedTabIds);
  return afterSnapshot.filter(
    (tab) => !beforeIds.has(tab.tabId) && !owned.has(tab.tabId),
  );
}

async function snapshotCurrentTabs() {
  const tabs = await listTabs();
  return tabs.map((tab) => ({ tabId: tab.tabId, label: tab.label }));
}

async function writeSnapshot(snapshot) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot), "utf8");
}

async function readSnapshot() {
  return JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
}

function describeResidualTab(tab) {
  return `${tab.tabId} (label: ${tab.label})`;
}

async function runPretest() {
  await writeSnapshot(await snapshotCurrentTabs());
}

async function runPosttest() {
  const before = await readSnapshot();
  const after = await snapshotCurrentTabs();
  await rm(SNAPSHOT_PATH, { force: true });

  const nameOwners = await listNameOwners();
  const ownedTabIds = nameOwners.map((owner) => owner.tabId);
  const residualTabs = findResidualTabs(before, after, ownedTabIds);
  if (residualTabs.length === 0) {
    return;
  }
  console.error(
    `herdr-tab-leak-guard: ${residualTabs.length} tab(s) leaked by this test run:\n` +
      residualTabs
        .map(describeResidualTab)
        .map((line) => `  - ${line}`)
        .join("\n"),
  );
  process.exitCode = 1;
}

const isDirectlyExecuted = import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) {
  const mode = process.argv[2];
  if (mode === "pretest") {
    await runPretest();
  } else if (mode === "posttest") {
    await runPosttest();
  } else {
    console.error(
      `herdr-tab-leak-guard: unknown mode "${mode}" — expected "pretest" or "posttest"`,
    );
    process.exitCode = 1;
  }
}
