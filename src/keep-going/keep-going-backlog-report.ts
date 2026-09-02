// Observe-and-report only: counts the Regent queue's unlaunched backlog and
// renders it as one more line of keep-going's existing per-tick report,
// mirroring keep-going-pressure-report.ts's shape. This module has zero
// authority to launch or affect any agent -- it reads the queue store and
// produces text. No spawn action is reachable from here (proven structurally
// by keep-going-backlog-report-no-spawn-path.test.ts).
//
// "Unlaunched" is defined as status === Open, NOT "agent_name is null".
// Measured fact (2026-08-16, KGQ campaign): of 201 open items, agent_name is
// populated on ZERO; across all 460 rows, agent_name/target_repo/base_commit/
// delivery_commit are each populated on exactly TWO, including rows from five
// gabledge campaigns that demonstrably ran real Alphas and delivered real
// commits. Those provenance columns exist in the schema but are essentially
// never written -- counting by them would silently undercount every
// campaign that actually launched. `status`, by contrast, is the field the
// state machine (regent-queue-item-state.ts) enforces on every write:
// open -> in-flight -> {complete | abandoned}. It is the one column this
// store's own transition guard keeps honest, so it is the only field a
// backlog count can trust.
//
// The remedy command is the path-qualified canonical form
// `<throne root>/bin/throne-cli render-queue` -- `./bin/throne-cli` is
// canonical (the form ~52 other remedy strings in this repo use, and the
// form AGENTS.md documents), but a bare relative path fails outside a
// throne checkout, and a keep-going nudge is read from wherever the Regent
// happens to be standing. Path-qualifying keeps the canonical script while
// making it resolve from anywhere, without introducing a second launcher
// form (`throne`, the PATH launcher) that keep-going does not otherwise use.
//
// Known accepted risk: `bin/throne-cli` self-heals a missing `dist/` by
// running `npm install` + `npm run build` before executing (see its own
// comments). That self-heal is a real behavior of the script this line
// names. It is accepted here because the printed path always points at
// `RUNTIME_THRONE_ROOT` -- the LIVE throne checkout that keep-going itself
// is running compiled code out of -- and that checkout's `dist/` is, by
// construction, already built whenever keep-going is alive to print the
// line. The self-heal path is real but not reachable through this
// particular remedy string in practice.

import { openRegentQueueStore } from '../regent-queue/regent-queue.store.ts';
import { RegentQueueItemStatus } from '../regent-queue/regent-queue-item-state.ts';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';

/** The canonical remedy command, path-qualified against the live throne root so it resolves from anywhere. */
export function backlogRemedyCommand(throneRoot: string = RUNTIME_THRONE_ROOT): string {
  return `${throneRoot}/bin/throne-cli render-queue`;
}

/**
 * Counts queue items still in status Open (queued, not yet picked up by any
 * campaign) against the durable Regent queue store. Reads only -- never
 * transitions a row. `databasePath` is parameterized only so tests can point
 * at a fixture store; production always calls this with no arguments.
 */
export function countUnlaunchedQueueItems(databasePath?: string): number {
  const store =
    databasePath === undefined ? openRegentQueueStore() : openRegentQueueStore(databasePath);
  try {
    const result = store.readAll();
    if (result.state !== 'items') {
      return 0;
    }
    return result.items.filter((item) => item.status === RegentQueueItemStatus.Open).length;
  } finally {
    store.close();
  }
}

/**
 * Renders the backlog count as a keep-going report line. Silent (empty
 * string) at zero backlog: the "counts alone are not read" finding (KGQ
 * campaign) argues against adding a routine always-present line that blends
 * into the other 22 ignored ticks a day -- a nonzero backlog instead
 * produces an ANOMALOUS line, one that is absent on every ordinary tick and
 * therefore harder to skim past than a number sitting in the same spot every
 * time. The line states the action, not just the fact: it names the exact
 * command to run, not merely the count.
 */
export function formatQueueBacklogReportLine(
  unlaunchedCount: number,
  remedyCommand: string = backlogRemedyCommand(),
): string {
  if (unlaunchedCount <= 0) {
    return '';
  }
  return (
    `keep-going: ${unlaunchedCount} unlaunched queue item(s) backlogged -- ` +
    `RUN: ${remedyCommand}\n`
  );
}
