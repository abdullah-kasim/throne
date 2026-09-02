import { repoRoot, runGit } from "../git-lifecycle/git-command.service.ts";
import { THRONE_PROJECT_DIR } from "../git-lifecycle/git-worktree.service.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { DELIVERY_EVIDENCE_DATA } from "../agentdata/delivery-evidence-data.service.ts";

/**
 * A second, independent completion signal alongside REPORT.md: `mergeBack`
 * (`src/git-lifecycle/merge.ts`) always stamps a delivered agent's work with
 * a commit titled exactly `Deliver <name>` (see `mergeBack` in
 * `src/git-lifecycle/delivery.ts`).
 * Finding that commit anywhere in the throne's local branch history proves
 * the agent's work actually landed — REPORT.md alone only proves the agent
 * *claimed* completion, not that the claim was published anywhere.
 *
 * `--all` deliberately checks every local branch/ref (not just the current
 * one): the target branch recorded in the agent's own delivery ledger may
 * not be checked out in this worktree at gate time.
 */
/** Escapes every extended-regex metacharacter so an agent name is matched
 *  literally, not interpreted as a pattern. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The delivered commit hash recorded in `name`'s DeliveryEvidenceRecord
 * ledger entry, or `undefined` when there is no ledger entry, or its stamped
 * repo does not canonicalize to the repo being searched (a mismatch is
 * treated as no evidence, never a false match). Consulted ahead of the
 * `Deliver <name>` grep so an agent delivered through the ledger-writing
 * path never needs its commit message parsed at all.
 */
async function findLedgerDeliveryCommit(
  name: string,
  requestedRepoRoot: string,
  dataDir?: string,
): Promise<string | undefined> {
  const record = await DELIVERY_EVIDENCE_DATA.read(name, dataDir);
  if (record === null) return undefined;
  try {
    const recordRepoRoot = await repoRoot(record.repo);
    return recordRepoRoot === requestedRepoRoot ? record.commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The full hash of `name`'s delivered commit, or `undefined` when none is
 * found (no ledger entry and no matching `Deliver <name>` commit in history).
 * Reads the DeliveryEvidenceRecord ledger first; only falls back to grepping
 * commit messages (no git repo, no history, any other git failure, or
 * genuinely no such commit) for agents delivered before the ledger record
 * existed — the "does a delivery commit exist" query `hasDeliveryCommit`
 * uses, but returning the hash itself rather than collapsing it to a
 * boolean, for callers (e.g. the Regent queue's reap write-back) that need
 * the commit to record, not just its presence.
 */
export async function findDeliveryCommitHash(
  name: string,
  repoRoot: string = THRONE_PROJECT_DIR,
  dataDir?: string,
): Promise<string | undefined> {
  return (await findDeliveryCommitHashes(name, repoRoot, dataDir))[0];
}

export async function findDeliveryCommitHashes(
  name: string,
  repoRoot: string = THRONE_PROJECT_DIR,
  dataDir?: string,
): Promise<string[]> {
  const ledgerCommit = await findLedgerDeliveryCommit(name, repoRoot, dataDir);
  if (ledgerCommit !== undefined) return [ledgerCommit];
  // Anchored so "Deliver alpha-hbq" cannot false-positive off a real commit
  // for "Deliver alpha-hbq-heartbeat-queue".
  const pattern = `^Deliver ${escapeRegExp(name)}$`;
  try {
    const stdout = await runGit(
      ["log", "--all", "--extended-regexp", `--grep=${pattern}`, "--format=%H"],
      repoRoot,
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    // No git repo, no history, or any other git failure: no proof, not an
    // error — the caller falls back to (or stays refused by) REPORT.md alone.
    return [];
  }
}

export async function hasDeliveryCommit(
  name: string,
  repoRoot: string = THRONE_PROJECT_DIR,
  dataDir?: string,
): Promise<boolean> {
  return (await findDeliveryCommitHash(name, repoRoot, dataDir)) !== undefined;
}

/**
 * Resolves the repo `hasDeliveryCommit` should search for a given agent: its
 * recorded `tree-base.json` `repo` field, canonicalized via `repoRoot`
 * (`git rev-parse --show-toplevel`) so a cross-repo delivery (e.g. a Shadow
 * whose target was gabledge, not the throne) is found in the repo it
 * actually landed in, instead of being structurally invisible to a search
 * that always defaults to the throne's own history.
 *
 * Falls back to `THRONE_PROJECT_DIR` — today's shipped, already-accepted
 * behavior — whenever `repo` is absent (a legacy record, or a same-repo
 * throne campaign that never recorded one) or resolution fails for any
 * reason (missing/unreadable tree-base.json, a `repoRoot` git call that
 * errors). Silently searching the wrong repo on a resolution failure would
 * be bad, but crashing `complete-agent`/`reap-agent` over it would be worse:
 * this always degrades to the same-repo-only search that already shipped,
 * never throws.
 */
export async function resolveDeliveryRepoRoot(
  name: string,
  dataDir?: string,
): Promise<string> {
  try {
    const record = await TREE_BASE_DATA.read(name, dataDir);
    if (record?.repo === undefined) return THRONE_PROJECT_DIR;
    return await repoRoot(record.repo);
  } catch {
    return THRONE_PROJECT_DIR;
  }
}
