import path from "node:path";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { indexClearsDirectory } from "../tmp-scratch-lifecycle/scratch-dir-holders.ts";
import type { ScratchHolderIndex } from "../tmp-scratch-lifecycle/tmp-scratch-lifecycle.types.ts";
import { looksWorktreeHomeShaped, resolveAgentNameCandidate } from "./scratchpad-attribution.ts";

export const RECLAIM_VERDICTS = {
  RECLAIMABLE: "RECLAIMABLE",
  UNKNOWN: "UNKNOWN",
} as const;

export type ReclaimVerdict = (typeof RECLAIM_VERDICTS)[keyof typeof RECLAIM_VERDICTS];

export interface ReclaimEntry {
  readonly dirPath: string;
  readonly verdict: ReclaimVerdict;
  readonly reason: string;
  /** The single agent name this entry's slug positively attributed to, or
   *  `undefined` when no attribution was possible — independent of the
   *  final verdict, so a caller can audit attribution coverage across an
   *  entire run (see `checkAttributionConsistency`) without re-parsing
   *  `reason`. */
  readonly attributedAgentName: string | undefined;
}

/** Read-only evidence sources the classifier consults. Every method's
 *  `undefined` return means "could not be resolved" — distinct from a
 *  resolved negative — and always drives the candidate toward `UNKNOWN`,
 *  never toward `RECLAIMABLE`. */
export interface AttributionReader {
  /** Live agents from the same roster source the worktree-husk reclaim tool reuses,
   *  or `undefined` when the roster itself could not be read. Fetched
   *  exactly once per `classifyScratchpads` run by the caller, never by
   *  `classifyScratchpadEntry` itself. */
  agents(): Promise<HerdrAgent[] | undefined>;
  /** Whether `agentName` is present under `data/.reaped/<agentName>/`, or
   *  `undefined` when that read failed. */
  reapedRecordExists(agentName: string): Promise<boolean | undefined>;
  /** OS-process holder evidence for one directory, from the shared `/proc`
   *  walk primitive, or `undefined` when unreadable. Used only for the fresh, unconditional
   *  race check immediately before an actual delete — classification itself
   *  is answered from the once-per-run `ScratchHolderIndex` instead. */
  procHolders(dirPath: string): Promise<{ pid: number }[] | undefined>;
  /** A once-per-sweep snapshot of every path a live process currently holds,
   *  built by `buildScratchHolderIndex`. Fetched exactly once per
   *  `classifyScratchpads` run by the caller, never by
   *  `classifyScratchpadEntry` itself. */
  holderIndex(): Promise<ScratchHolderIndex>;
}

function liveAgentName(agent: HerdrAgent): string | undefined {
  return agent.tabLabel ?? agent.name;
}

function findLiveMatch(agents: HerdrAgent[], candidateName: string): HerdrAgent | undefined {
  return agents.find((agent) => sameAgentName(liveAgentName(agent), candidateName));
}

/**
 * Classifies one `/tmp/claude-1000` entry. Every candidate STARTS `UNKNOWN`
 * — the return is built by finding the single affirmative path to
 * `RECLAIMABLE`, never by finding a reason to skip an assumed removal.
 * `RECLAIMABLE` requires ALL FOUR, in order, each one ANDed onto the last:
 *   1. the entry name resolves to exactly one throne agent name;
 *   2. that name has no live roster entry;
 *   3. that name IS present under `data/.reaped/<name>/`;
 *   4. the once-per-run holder index proves nothing currently holds it.
 * Any unresolvable read at any step is `UNKNOWN`, permanently — never
 * "reclaim anyway" and never revisited by relaxing a later step. The roster
 * (`liveAgents`) and holder snapshot (`holderIndex`) are both resolved once
 * per `classifyScratchpads` run and passed in here as plain values, never
 * fetched per-candidate.
 */
export async function classifyScratchpadEntry(
  dirPath: string,
  entryName: string,
  worktreesHome: string,
  repoNames: readonly string[],
  liveAgents: HerdrAgent[] | undefined,
  holderIndex: ScratchHolderIndex,
  reader: Pick<AttributionReader, "reapedRecordExists">,
): Promise<ReclaimEntry> {
  const candidateName = resolveAgentNameCandidate(entryName, worktreesHome, repoNames);
  const unknown = (reason: string): ReclaimEntry => ({
    dirPath,
    verdict: RECLAIM_VERDICTS.UNKNOWN,
    reason,
    attributedAgentName: candidateName,
  });

  if (candidateName === undefined) {
    return unknown(
      "not worktree-slug-shaped under any known repo — no exact agent-name attribution is possible",
    );
  }

  if (liveAgents === undefined) {
    return unknown(
      `slug resolves to agent name "${candidateName}", but the live agent roster could not be read`,
    );
  }
  const liveMatch = findLiveMatch(liveAgents, candidateName);
  if (liveMatch !== undefined) {
    return unknown(
      `protected: slug resolves to live roster entry "${liveAgentName(liveMatch)}" ` +
        `(status: ${liveMatch.agentStatus}, cwd: ${liveMatch.cwd})`,
    );
  }

  const reaped = await reader.reapedRecordExists(candidateName);
  if (reaped === undefined) {
    return unknown(
      `slug resolves to agent name "${candidateName}" (no live roster entry), but its ` +
        `data/.reaped/ record could not be read`,
    );
  }
  if (!reaped) {
    return unknown(
      `slug resolves to agent name "${candidateName}", which has no live roster entry ` +
        `and no data/.reaped/ record — never reaped, or reaped under a different name`,
    );
  }

  if (!indexClearsDirectory(holderIndex, dirPath)) {
    return unknown(
      `agent "${candidateName}" is reaped, but the once-per-run live-process holder ` +
        "snapshot does not clear this directory (either it is still held, or the snapshot " +
        "itself could not be reliably built)",
    );
  }

  return {
    dirPath,
    verdict: RECLAIM_VERDICTS.RECLAIMABLE,
    reason:
      `agent "${candidateName}" has no live roster entry, is present under ` +
      `data/.reaped/${candidateName}/, and the once-per-run holder snapshot shows no live ` +
      "process holding this directory",
    attributedAgentName: candidateName,
  };
}

export interface AttributionConsistencyCheck {
  readonly worktreeShapedCount: number;
  readonly attributedCount: number;
  readonly consistent: boolean;
}

/**
 * Loud internal-consistency check: if the scan found N worktree-shaped
 * entries (candidates for slug attribution at all) and ZERO of them ever
 * resolved to a `candidateName`, that is an inconsistency, not a clean
 * "nothing to do" result — the classifier is failing to attribute things it
 * should be able to attribute (e.g. the default `worktreesRoot` silently
 * pointing at the wrong path). An empty or genuinely non-worktree-shaped
 * population (`worktreeShapedCount === 0`) is a normal, consistent result.
 */
export function checkAttributionConsistency(
  entries: readonly ReclaimEntry[],
  worktreesHome: string,
): AttributionConsistencyCheck {
  const worktreeShapedCount = entries.filter((entry) =>
    looksWorktreeHomeShaped(path.basename(entry.dirPath), worktreesHome),
  ).length;
  const attributedCount = entries.filter((entry) => entry.attributedAgentName !== undefined).length;
  return {
    worktreeShapedCount,
    attributedCount,
    consistent: worktreeShapedCount === 0 || attributedCount > 0,
  };
}
