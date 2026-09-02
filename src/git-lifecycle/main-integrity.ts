// Foreign-commit detection for a protected branch (ordinarily the live
// checkout's `main`): the ONE shared predicate for "is this advance explained
// entirely by recorded, legitimate deliveries" — never re-derived ad hoc
// between the command and its test.
//
// The discriminator deliberately does NOT trust a commit's author identity or
// message. The incident this guards against is exactly a commit that looked
// legitimate by message and author (every worktree and the live checkout
// share one git committer identity, so identity carries no signal; a hand
// commit can carry any message it likes). Instead each new commit reachable
// since the last known-good tip must appear as the recorded `commit` of some
// agent's `DeliveryEvidenceRecord` (`delivery-evidence.json`, written by
// `mergeBack`/`stampNoopDelivery` at publish time from the delivery
// machinery's own commit-tree call, never parsed from a message) whose
// stamped `repo` resolves to this same repo. A `git merge --ff-only` delivery
// moves the branch ref onto an already-published, already-ledgered commit
// rather than creating a new one, so it needs no separate case here.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "../agentdata/spawn-data-contracts.ts";
import { DELIVERY_EVIDENCE_DATA } from "../agentdata/delivery-evidence-data.service.ts";
import { localBranchTip, readReachability } from "./branch-authority.ts";
import { readGitStatus, repoRoot, runGit } from "./git-command.service.ts";

/** The lightweight git ref this module moves as the durable known-good
 *  marker — no filesystem ledger entry, and it moves atomically with the
 *  same `update-ref` primitive every delivery in this codebase already
 *  uses. */
const KNOWN_GOOD_REF = "refs/throne/main-known-good";

export interface OffendingCommit {
  sha: string;
  subject: string;
}

export type MainIntegrityVerdict =
  | { status: "no-baseline"; branch: string; tip: string }
  | { status: "clean"; branch: string; tip: string }
  | {
      status: "foreign-commit-detected";
      branch: string;
      knownGoodTip: string;
      currentTip: string;
      offending: OffendingCommit[];
      reason: string;
    };

/** Every commit hash recorded as a legitimate delivery product for `root`,
 *  gathered by reading every registered agent's `delivery-evidence.json`
 *  under `dataDir` and keeping only the records whose stamped `repo`
 *  resolves to `root`. A missing/malformed record is silently skipped (the
 *  same "no proof, not an error" posture `delivery-commit-proof.ts` uses) —
 *  it simply contributes no legitimacy evidence, it never widens the set. */
async function readLedgeredDeliveryCommits(
  root: string,
  dataDir: string,
): Promise<Set<string>> {
  const commits = new Set<string>();
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return commits;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await DELIVERY_EVIDENCE_DATA.read(entry.name, dataDir);
    if (record === null) continue;
    try {
      if ((await repoRoot(record.repo)) === root) commits.add(record.commit);
    } catch {
      // record.repo no longer resolves to a git repo — no legitimacy proof.
    }
  }
  return commits;
}

async function readKnownGoodTip(root: string): Promise<string | undefined> {
  const result = await readGitStatus(
    ["show-ref", "--verify", "--quiet", KNOWN_GOOD_REF],
    root,
  );
  if (result.code === 1) return undefined;
  if (result.code !== 0) {
    throw new Error(
      `cannot inspect "${KNOWN_GOOD_REF}": ` +
        `${result.stderr.trim() || `git exited ${result.code}`}`,
    );
  }
  return (await runGit(["rev-parse", KNOWN_GOOD_REF], root)).trim();
}

async function recordKnownGoodTip(root: string, commit: string): Promise<void> {
  await runGit(["update-ref", KNOWN_GOOD_REF, commit], root);
}

async function describeCommit(root: string, sha: string): Promise<string> {
  return (await runGit(["log", "-1", "--format=%s", sha], root)).trim();
}

export interface CheckMainIntegrityDeps {
  dataDir?: string;
}

/**
 * Compares `branch`'s current tip against the last recorded known-good tip
 * and reports whether the advance is explained entirely by recorded
 * deliveries. Never mutates `branch` itself. On a clean run (including the
 * very first run, which has no baseline to compare against) it advances the
 * known-good marker to the current tip; on a flagged foreign commit it does
 * NOT — a flagged advance keeps flagging on every subsequent run until a
 * human/Alpha resolves it, never a one-shot alarm.
 */
export async function checkMainIntegrity(
  root: string,
  branch: string,
  deps: CheckMainIntegrityDeps = {},
): Promise<MainIntegrityVerdict> {
  const dataDir = deps.dataDir ?? DEFAULT_DATA_DIR;

  const currentTip = await localBranchTip(root, branch);
  if (currentTip === undefined) {
    throw new Error(`branch "${branch}" does not exist in "${root}"`);
  }

  const knownGoodTip = await readKnownGoodTip(root);
  if (knownGoodTip === undefined) {
    await recordKnownGoodTip(root, currentTip);
    return { status: "no-baseline", branch, tip: currentTip };
  }

  if (knownGoodTip === currentTip) {
    return { status: "clean", branch, tip: currentTip };
  }

  const reachability = await readReachability(root, knownGoodTip, currentTip);
  if (reachability.code !== 0) {
    return {
      status: "foreign-commit-detected",
      branch,
      knownGoodTip,
      currentTip,
      offending: [
        {
          sha: currentTip,
          subject: await describeCommit(root, currentTip),
        },
      ],
      reason:
        `the known-good tip "${knownGoodTip}" is not an ancestor of the ` +
        `current tip "${currentTip}" — branch "${branch}" was rewound, ` +
        "rebased, or force-pushed past its recorded baseline",
    };
  }

  const range = (
    await runGit(["rev-list", `${knownGoodTip}..${currentTip}`], root)
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const legitimate = await readLedgeredDeliveryCommits(root, dataDir);
  const foreign = range.filter((sha) => !legitimate.has(sha));
  if (foreign.length > 0) {
    const offending: OffendingCommit[] = [];
    for (const sha of foreign) {
      offending.push({ sha, subject: await describeCommit(root, sha) });
    }
    return {
      status: "foreign-commit-detected",
      branch,
      knownGoodTip,
      currentTip,
      offending,
      reason:
        `${foreign.length} commit(s) between the known-good tip and the ` +
        `current tip of "${branch}" are not recorded as a legitimate ` +
        "delivery in any agent's delivery-evidence ledger",
    };
  }

  await recordKnownGoodTip(root, currentTip);
  return { status: "clean", branch, tip: currentTip };
}

export { KNOWN_GOOD_REF };
