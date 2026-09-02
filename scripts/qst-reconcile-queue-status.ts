import { homedir } from "node:os";
import path from "node:path";
import {
  openRegentQueueStore,
  RegentQueueItemStatus,
  type RegentQueueItemRow,
  type RegentQueueStore,
} from "../src/regent-queue/regent-queue.store.ts";
import { findDeliveryCommitHash } from "../src/git-lifecycle/delivery-commit-proof.ts";
import { repoRoot, runGit } from "../src/git-lifecycle/git-command.service.ts";
import { THRONE_PROJECT_DIR } from "../src/git-lifecycle/git-worktree.service.ts";

/**
 * One-time backlog reconciliation over the live Regent queue: an item stays
 * `open`/`in-flight` forever unless something walks the backlog and matches
 * it against real delivery evidence. This is that walk. It never invents a
 * delivery commit — every `complete` transition below carries a hash
 * `findDeliveryCommitHash` actually found.
 */

export const GABLEDGE_REPO_PATH = path.join(
  process.env.HOME ?? homedir(),
  "repos",
  "gabledge",
);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  RegentQueueItemStatus.Complete,
  RegentQueueItemStatus.Abandoned,
]);

/**
 * Language near a mention that means the item text itself contradicts
 * completion — a bare name match is not enough evidence when the item says
 * outright that the work isn't done.
 */
const NEGATING_PHRASES: readonly string[] = [
  "not yet delivered",
  "not delivered",
  "still open",
  "still blocked",
  "not complete",
  "not done",
  "superseded",
  "replaced by",
];

const SENTENCE_BOUNDARY_CHARS = new Set([".", "!", "?", "\n"]);

function lastSentenceBoundaryBefore(body: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (SENTENCE_BOUNDARY_CHARS.has(body[i])) return i;
  }
  return -1;
}

function firstSentenceBoundaryFrom(body: string, index: number): number {
  for (let i = index; i < body.length; i += 1) {
    if (SENTENCE_BOUNDARY_CHARS.has(body[i])) return i;
  }
  return body.length;
}

/** Whether negating language appears in the same sentence as `needle`'s
 *  first occurrence in `body` — scoped to one sentence, not a fixed
 *  character window, so an unrelated negated sentence earlier or later in
 *  the same item never bleeds into this mention's verdict. Case-insensitive;
 *  a needle absent from the body never negates (callers only pass needles
 *  they know are present). */
function bodyNegatesCompletionNear(body: string, needle: string): boolean {
  const index = body.indexOf(needle);
  if (index === -1) return false;
  const sentenceStart = lastSentenceBoundaryBefore(body, index) + 1;
  const sentenceEnd = firstSentenceBoundaryFrom(body, index);
  const sentence = body.slice(sentenceStart, sentenceEnd).toLowerCase();
  return NEGATING_PHRASES.some((phrase) => sentence.includes(phrase));
}

/** Every distinct `alpha-<code>-<slug>`-shaped token mentioned in an item's
 *  body text, in first-seen order. Pure regex extraction — no I/O. */
export function extractAgentMentions(body: string): string[] {
  const pattern = /alpha-[a-z0-9]+(?:-[a-z0-9]+)+/g;
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const match of body.matchAll(pattern)) {
    const token = match[0];
    if (!seen.has(token)) {
      seen.add(token);
      mentions.push(token);
    }
  }
  return mentions;
}

export type ClassifyVerdict =
  | "reconcile"
  | "no-mention"
  | "unverifiable-repo"
  | "no-delivery-evidence"
  | "already-terminal";

export interface ClassifyItemInput {
  readonly status: string;
  readonly body: string;
}

export interface ClassifyItemResult {
  readonly verdict: ClassifyVerdict;
  readonly reason: string;
  readonly deliveryCommit?: string;
  readonly deliveredAgent?: string;
}

/**
 * Pure decision function: given an item and the delivery evidence already
 * looked up for each of its body-mentioned agents, decide whether it should
 * reconcile to `complete`. `evidenceByAgent` encodes a tri-state per mention
 * via Map semantics: an absent key means the mention's repo could not be
 * checked at all (unverifiable), a present key mapped to `undefined` means
 * the repo was checked and had no matching `Deliver` commit, and a present
 * key mapped to a string is the found commit hash.
 */
export function classifyItem(
  item: ClassifyItemInput,
  evidenceByAgent: ReadonlyMap<string, string | undefined>,
): ClassifyItemResult {
  if (TERMINAL_STATUSES.has(item.status)) {
    return {
      verdict: "already-terminal",
      reason: `item status "${item.status}" is already terminal and is never reopened`,
    };
  }

  const mentions = extractAgentMentions(item.body);
  if (mentions.length === 0) {
    return {
      verdict: "no-mention",
      reason: "no alpha-<code>-<slug> agent mention found in the item body",
    };
  }

  let sawUnverifiableRepo = false;
  let sawNoEvidence = false;
  let negatedMatch: { agent: string } | undefined;

  for (const mention of mentions) {
    if (!evidenceByAgent.has(mention)) {
      sawUnverifiableRepo = true;
      continue;
    }
    const commit = evidenceByAgent.get(mention);
    if (commit === undefined) {
      sawNoEvidence = true;
      continue;
    }
    if (bodyNegatesCompletionNear(item.body, mention)) {
      negatedMatch = { agent: mention };
      continue;
    }
    return {
      verdict: "reconcile",
      reason: `mentioned agent "${mention}" has a matching Deliver commit and the item text does not contradict completion`,
      deliveredAgent: mention,
      deliveryCommit: commit,
    };
  }

  if (negatedMatch !== undefined) {
    return {
      verdict: "no-delivery-evidence",
      reason: `mentioned agent "${negatedMatch.agent}" has a Deliver commit but nearby item text negates completion`,
    };
  }
  if (sawNoEvidence) {
    return {
      verdict: "no-delivery-evidence",
      reason: `mentioned agent(s) [${mentions.join(", ")}] have no matching Deliver commit`,
    };
  }
  return {
    verdict: "unverifiable-repo",
    reason: `mentioned agent(s) [${mentions.join(", ")}] could not be checked against any accessible repo`,
  };
}

/**
 * Applies the two-call `transitionStatus` sequence the state machine
 * requires (there is no direct `open -> complete` edge): `in-flight` first
 * (skipped when the item is already `in-flight`), then `complete`, stamping
 * the evidence in the same calls via `RegentQueueStore`'s existing
 * `COALESCE`-on-write semantics.
 */
export function reconcile(
  store: RegentQueueStore,
  item: RegentQueueItemRow,
  evidence: { agentName: string; targetRepo: string; deliveryCommit: string },
): RegentQueueItemRow {
  if (item.status !== RegentQueueItemStatus.InFlight) {
    store.transitionStatus(item.id, RegentQueueItemStatus.InFlight, {
      agentName: evidence.agentName,
      targetRepo: evidence.targetRepo,
    });
  }
  return store.transitionStatus(item.id, RegentQueueItemStatus.Complete, {
    agentName: evidence.agentName,
    targetRepo: evidence.targetRepo,
    deliveryCommit: evidence.deliveryCommit,
  });
}

/**
 * The 16 gabledge migration items (`migrate-queue-0052`..`migrate-queue-0067`,
 * `objective_code` `gbm-01`..`gbm-16`) predate agent-name mentions entirely —
 * they are freeform spec-chunk blocks carried over from a markdown migration
 * and never say `alpha-gbm<N>-<slug>` anywhere in their body, so
 * `extractAgentMentions`/`classifyItem` structurally cannot reach them. This
 * is their dedicated path: derive the
 * delivered agent name, if any, from the one Alpha-level `Deliver
 * alpha-gbm<N>-...` commit in gabledge history for that chunk number,
 * reusing `findDeliveryCommitHash` for the actual evidence lookup — this
 * does not reimplement `findDeliveryCommitHash`'s exact-match grep, it only
 * resolves the *name* that grep needs, which the migrated body text does not
 * supply.
 */
async function deriveGbmMigratedAgentName(
  chunkNumber: number,
  repoPath: string,
): Promise<string | undefined> {
  let stdout: string;
  try {
    stdout = await runGit(
      [
        "log",
        "--all",
        "--extended-regexp",
        `--grep=^Deliver alpha-gbm${chunkNumber}-`,
        "--format=%s",
      ],
      repoPath,
    );
  } catch {
    return undefined;
  }
  const names = new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^Deliver /, "")),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

export interface ReconciledRecord {
  readonly id: string;
  readonly agent: string;
  readonly commit: string;
  readonly repo: string;
}

export interface StayedOpenRecord {
  readonly id: string;
  readonly mentions: string[];
  readonly reason: string;
}

async function repoIsAccessible(repoPath: string): Promise<boolean> {
  try {
    await repoRoot(repoPath);
    return true;
  } catch {
    return false;
  }
}

async function reconcileGbmMigratedChunk(
  store: RegentQueueStore,
  item: RegentQueueItemRow,
  chunkNumber: number,
): Promise<{ reconciled?: ReconciledRecord; stayedOpen?: StayedOpenRecord }> {
  if (!(await repoIsAccessible(GABLEDGE_REPO_PATH))) {
    return {
      stayedOpen: {
        id: item.id,
        mentions: [],
        reason: `gabledge repo not accessible at ${GABLEDGE_REPO_PATH}`,
      },
    };
  }
  const deliveredAgent = await deriveGbmMigratedAgentName(chunkNumber, GABLEDGE_REPO_PATH);
  if (deliveredAgent === undefined) {
    return {
      stayedOpen: {
        id: item.id,
        mentions: [],
        reason: `no unambiguous "Deliver alpha-gbm${chunkNumber}-..." commit found in gabledge history`,
      },
    };
  }
  const commit = await findDeliveryCommitHash(deliveredAgent, GABLEDGE_REPO_PATH);
  if (commit === undefined) {
    return {
      stayedOpen: {
        id: item.id,
        mentions: [deliveredAgent],
        reason: `derived agent "${deliveredAgent}" has no matching Deliver commit hash`,
      },
    };
  }
  const headingMarker = `GBM-${String(chunkNumber).padStart(2, "0")}`;
  if (bodyNegatesCompletionNear(item.body, headingMarker)) {
    return {
      stayedOpen: {
        id: item.id,
        mentions: [deliveredAgent],
        reason: `item text negates completion near its ${headingMarker} heading`,
      },
    };
  }
  const updated = reconcile(store, item, {
    agentName: deliveredAgent,
    targetRepo: GABLEDGE_REPO_PATH,
    deliveryCommit: commit,
  });
  return {
    reconciled: { id: updated.id, agent: deliveredAgent, commit, repo: GABLEDGE_REPO_PATH },
  };
}

/**
 * Report-only: evaluate a body-mentioned agent's delivery evidence via the
 * same pure `classifyItem` used for GBM chunks, but never apply it.
 *
 * A live dry-run against this queue proved bare mention-plus-evidence
 * matching unsafe on this store's actual writing style: agent names are
 * routinely cited as *examples*, *discoverers*, or *background evidence* for
 * an unrelated ask, not just as self-reports of "this item's own work is
 * done." Concrete false positives caught before any write survived: item
 * `qst` (this very reconciliation campaign's own live in-flight queue item)
 * cites `alpha-gbm1-fixes-deletions` only as an evidence example in its own
 * bug report and would have been marked `complete` mid-campaign; item `gbm5`
 * (a sibling live in-flight campaign) cites `alpha-gbm4-mode-routes` only as
 * the dependency it was unblocked by; `migrate-queue-0016` ("BOXLOCK") cites
 * two agents purely as the two who broke the rule it is asking to enforce;
 * `migrate-queue-0106` ("CROSSREPOPROOF") cites `alpha-gbm3-pursuit-model`
 * only as the campaign that *discovered* its still-open defect. None of
 * these items' own work was delivered. Recovering from the false-positive
 * writes this proved required a full-DB restore from a pre-run backup before
 * this report-only path replaced the earlier auto-apply behavior.
 *
 * The GBM-chunk path (`reconcileGbmMigratedChunk`) is unaffected and
 * deliberately kept live: it derives its candidate agent name from the
 * item's own `objective_code`-anchored chunk number, not from an incidental
 * body citation, so it cannot reproduce this failure mode.
 */
async function evaluateMentionedItemForReport(
  item: RegentQueueItemRow,
  mentions: string[],
): Promise<StayedOpenRecord> {
  const repoPath = /gabledge/i.test(item.body) ? GABLEDGE_REPO_PATH : THRONE_PROJECT_DIR;
  const evidenceByAgent = new Map<string, string | undefined>();
  if (await repoIsAccessible(repoPath)) {
    for (const mention of mentions) {
      evidenceByAgent.set(mention, await findDeliveryCommitHash(mention, repoPath));
    }
  }
  const classification = classifyItem(item, evidenceByAgent);
  const reason =
    classification.verdict === "reconcile"
      ? `mention-based auto-reconciliation withheld: agent "${classification.deliveredAgent}" commit ${classification.deliveryCommit} was only mentioned in this item's body, not confirmed as the item's own deliverer, so the match is not trustworthy without deliverer-identity correlation`
      : classification.reason;
  return { id: item.id, mentions, reason };
}

const GBM_OBJECTIVE_CODE = /^gbm-(\d+)$/i;

/** Never reopened or reconsidered — its own body already correctly reports
 *  that GBM-01/02 delivered, so its `complete` status is accurate as written;
 *  reopening it would suggest its own correction was wrong. */
const NEVER_TOUCHED_ITEM_IDS: ReadonlySet<string> = new Set(["migrate-queue-0104"]);

export interface ReconciliationRunResult {
  readonly reconciled: ReconciledRecord[];
  readonly stayedOpen: StayedOpenRecord[];
  readonly totalOpenOrInFlightScanned: number;
}

export async function runReconciliation(
  store: RegentQueueStore,
): Promise<ReconciliationRunResult> {
  const readResult = store.readAll();
  if (readResult.state !== "items") {
    return { reconciled: [], stayedOpen: [], totalOpenOrInFlightScanned: 0 };
  }
  const candidates = readResult.items.filter(
    (item) =>
      !NEVER_TOUCHED_ITEM_IDS.has(item.id) &&
      (item.status === RegentQueueItemStatus.Open ||
        item.status === RegentQueueItemStatus.InFlight),
  );

  const reconciled: ReconciledRecord[] = [];
  const stayedOpen: StayedOpenRecord[] = [];

  for (const item of candidates) {
    const gbmMatch = GBM_OBJECTIVE_CODE.exec(item.objectiveCode ?? "");
    if (gbmMatch) {
      const outcome = await reconcileGbmMigratedChunk(store, item, Number(gbmMatch[1]));
      if (outcome.reconciled) reconciled.push(outcome.reconciled);
      if (outcome.stayedOpen) stayedOpen.push(outcome.stayedOpen);
      continue;
    }
    const mentions = extractAgentMentions(item.body);
    if (mentions.length === 0) continue;
    stayedOpen.push(await evaluateMentionedItemForReport(item, mentions));
  }

  return { reconciled, stayedOpen, totalOpenOrInFlightScanned: candidates.length };
}

async function main(): Promise<void> {
  const store = openRegentQueueStore();
  try {
    const result = await runReconciliation(store);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    store.close();
  }
}

const isDirectRun = process.argv[1]?.endsWith("qst-reconcile-queue-status.ts") ?? false;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
