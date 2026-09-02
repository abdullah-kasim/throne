import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { isDeepStrictEqual } from "node:util";
import { access } from "node:fs/promises";
import type { CapabilityEvidence } from "../harness-routing/policy/capabilities.ts";
import type { ModelPair } from "../config.ts";
export const DEFAULT_DATA_DIR = RUNTIME_DATA_DIR;
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface UsageBypassAuthorizationEvidence {
  authorizer: "Lord" | "Regent";
  objective_code: string;
  recipient: string;
  evidence_locator: string;
}

export interface StagerRouteAuthorizationEvidence {
  authorizer: "Lord";
  recipient: string;
  harness: string;
  model: string;
  evidence_locator: string;
}

export interface SpawnSpec {
  harness: string;
  model: string;
  model_hint?: ModelPair;
  effort: number;
  cwd: string;
  spawned_at?: string;
  routing_note?: string;
  objective_code?: string;
  non_campaign?: true;
  empty_worktree?: true;
  harness_executable?: string;
  passthrough_argv?: string[];
  session_id?: string;
  switched_at?: string;
  switched_from_model?: string;
  /** Historical-only score evidence; fresh records never write this field. */
  capability?: CapabilityEvidence;
  usage_bypass_authorization?: UsageBypassAuthorizationEvidence;
  stager_route_authorization?: StagerRouteAuthorizationEvidence;
  // Spawn+task atomicity tracking. Present (as `null` or an ISO timestamp)
  // only on resident Alpha/Shadow records written after this field was
  // introduced — a record spawned before it exists omits the field entirely,
  // which `find-untasked-agents` treats as "unknown, don't flag" rather than
  // "untasked", so no pre-existing live agent is retroactively misjudged.
  // `null` means registered but never yet tasked; an ISO string is the
  // instant `send-agent` first delivered/enqueued a message to this agent
  // (see `markAgentTasked`). See shadow-tbk-09, 2026-08-11: an Alpha spawned
  // a Shadow and its `send-agent` assignment call was silently dropped mid
  // multi-Shadow juggling; the Shadow sat at its bare identity prompt
  // indefinitely and was caught only by accident, ~30 minutes later, when
  // the whole family happened to go idle at once. `find-untasked-agents`
  // flags this per-agent instead of waiting on that coincidence.
  tasked_at?: string | null;
  // Token-lane load balancer evidence (dark behind `THRONE_TOKEN_BALANCE_ENABLED`
  // and the operator disable setting; see `src/token-balance/` and
  // `src/create-agent/lane-inheritance.ts`). `token_balance_lane` is the
  // lane a balanced-role (Alpha) spawn resolved once at spawn time;
  // `token_balance_mandate` records that an explicit per-campaign model
  // mandate suppressed lane gating instead. Exactly one of the two, or
  // neither (today's unbalanced default), is ever present — never both.
  // Descendant Shadow/ShadowSlice99 spawns read these fields verbatim off
  // their supervising Alpha's record and never re-derive them.
  token_balance_lane?: string;
  token_balance_mandate?: true;
  // Declares that this agent's correct completion output is a judgement
  // (a verdict, a finding, an answer) rather than a code diff, so a no-diff
  // merge-git-tree run is the expected outcome for it, not evidence of a
  // lost commit. Absent means the default, diff-producing shape. Written by
  // `create-agent` at spawn time as the sole NORMAL write path — nothing, no
  // OS permission and no separate ledger, stops the governed agent from
  // editing its own spawn.json afterward (every agent runs as the same OS
  // user with ordinary read/write on its own ledger directory, which is not
  // git-tracked or otherwise append-only). Doing so is possible but is
  // deliberate falsification of the agent's own ledger record, the same
  // category of trust violation as hand-editing a REPORT.md to fake
  // evidence never produced — this field is a stated, accepted residual,
  // never tamper-proof or cryptographically enforced.
  deliverable_shape?: "verdict-only";
}

/** Historical records remain readable while score evidence is retired. */
export function spawnCapabilityEvidenceIsValid(_value: unknown): boolean {
  return true;
}

const SPAWN_SPEC_BASENAME = "spawn.json";

export async function agentRegistrationExists(
  name: string,
  baseDir = DEFAULT_DATA_DIR,
): Promise<boolean> {
  const dir = path.join(baseDir, name);
  const [hasIdentity, hasSpawnSpec] = await Promise.all([
    fileExists(path.join(dir, "identity.md")),
    fileExists(path.join(dir, SPAWN_SPEC_BASENAME)),
  ]);
  return hasIdentity || hasSpawnSpec;
}

export async function writeSpawnSpec(
  name: string,
  spec: SpawnSpec,
  baseDir = DEFAULT_DATA_DIR,
): Promise<void> {
  const dir = path.join(baseDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, SPAWN_SPEC_BASENAME),
    `${JSON.stringify(spec, null, 2)}\n`,
    "utf8",
  );
}

function isUsageBypassAuthorizationEvidence(
  value: unknown,
): value is UsageBypassAuthorizationEvidence {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return (
    (evidence.authorizer === "Lord" || evidence.authorizer === "Regent") &&
    typeof evidence.objective_code === "string" &&
    evidence.objective_code !== "" &&
    typeof evidence.recipient === "string" &&
    evidence.recipient !== "" &&
    typeof evidence.evidence_locator === "string" &&
    evidence.evidence_locator !== "" &&
    Object.keys(evidence).every((key) =>
      [
        "authorizer",
        "objective_code",
        "recipient",
        "evidence_locator",
      ].includes(key),
    )
  );
}

function isStagerRouteAuthorizationEvidence(
  value: unknown,
): value is StagerRouteAuthorizationEvidence {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return (
    evidence.authorizer === "Lord" &&
    typeof evidence.recipient === "string" &&
    typeof evidence.harness === "string" &&
    typeof evidence.model === "string" &&
    typeof evidence.evidence_locator === "string"
  );
}

function isSpawnSpec(value: unknown): value is SpawnSpec {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.harness === "string" &&
    typeof record.model === "string" &&
    (record.model_hint === undefined ||
      (typeof record.model_hint === "object" && record.model_hint !== null &&
        typeof (record.model_hint as ModelPair).harness === "string" &&
        typeof (record.model_hint as ModelPair).model === "string")) &&
    typeof record.effort === "number" &&
    typeof record.cwd === "string" &&
    (record.harness_executable === undefined ||
      typeof record.harness_executable === "string") &&
    (record.passthrough_argv === undefined ||
      (Array.isArray(record.passthrough_argv) &&
        record.passthrough_argv.every((token) => typeof token === "string"))) &&
    (record.session_id === undefined ||
      typeof record.session_id === "string") &&
    (record.switched_at === undefined ||
      typeof record.switched_at === "string") &&
    (record.switched_from_model === undefined ||
      typeof record.switched_from_model === "string") &&
    (record.usage_bypass_authorization === undefined ||
      isUsageBypassAuthorizationEvidence(record.usage_bypass_authorization)) &&
    (record.stager_route_authorization === undefined ||
      isStagerRouteAuthorizationEvidence(record.stager_route_authorization)) &&
    (record.tasked_at === undefined ||
      record.tasked_at === null ||
      typeof record.tasked_at === "string") &&
    (record.deliverable_shape === undefined ||
      record.deliverable_shape === "verdict-only") &&
    (record.token_balance_lane === undefined ||
      typeof record.token_balance_lane === "string") &&
    (record.token_balance_mandate === undefined ||
      record.token_balance_mandate === true) &&
    !(
      record.token_balance_lane !== undefined &&
      record.token_balance_mandate !== undefined
    )
  );
}

export async function readSpawnSpec(
  name: string,
  baseDir = DEFAULT_DATA_DIR,
): Promise<SpawnSpec | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(baseDir, name, SPAWN_SPEC_BASENAME), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isSpawnSpec(parsed) ? parsed : null;
}

/**
 * Record that `name` was tasked, at `taskedAtIso`. A no-op — never an
 * error — whenever there is nothing meaningful to record: no spawn record
 * exists yet (e.g. the Regent, or a not-yet-registered recipient), the
 * record predates the `tasked_at` field (`undefined`, left alone so its
 * "unknown, don't flag" reading is preserved), or the agent is already
 * marked tasked (idempotent — a recipient's second and later `send-agent`
 * calls must not re-write its first-tasked instant). Callers treat a thrown
 * error as best-effort and swallow it: this bookkeeping must never fail the
 * `send-agent` call that is the actual delivery.
 */
export async function markAgentTasked(
  name: string,
  taskedAtIso: string,
  baseDir = DEFAULT_DATA_DIR,
): Promise<void> {
  const spec = await readSpawnSpec(name, baseDir);
  if (
    spec === null ||
    spec.tasked_at === undefined ||
    spec.tasked_at !== null
  ) {
    return;
  }
  await writeSpawnSpec(name, { ...spec, tasked_at: taskedAtIso }, baseDir);
}
