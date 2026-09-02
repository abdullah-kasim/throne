import path from "node:path";
import { getAgentStatusesRoster } from "../agent-statuses/agent-statuses-roster.ts";
import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import { MODEL_NAMES } from "../harness-routing/harness.ts";
import {
  DESIRED_STATES,
  readDesiredState,
  type DesiredState,
} from "../regent-state/regent-state.service.ts";
import { resolveRepoRootAndGenerationFromModuleUrl } from "../status/dist-generation.ts";
import {
  invokeThroneCliWithRetry,
  type CliInvocationOutcome,
} from "./retryable-cli-invoke.ts";

export const STAGER_FLOOR_AGENT_NAME = "stager-floor";

export type StagerFloorDecision =
  | { readonly action: "stay-down" }
  | { readonly action: "present"; readonly name: string }
  | { readonly action: "ensure" }
  | {
      readonly action: "refuse";
      readonly failureKind: "evidence" | "decision" | "actuation";
      readonly reason: string;
    };

export interface StagerFloorDependencies {
  readonly readDesiredState: () => Promise<DesiredState>;
  readonly readRoster: () => Promise<readonly AgentStatusesRosterEntry[]>;
  readonly resolvePublishedRuntime: () =>
    { readonly repoRoot: string; readonly cliEntrypoint: string } | undefined;
  readonly invokeCli: (
    executablePath: string,
    argv: readonly string[],
  ) => Promise<CliInvocationOutcome>;
  readonly log: (message: string) => void;
}

/**
 * The Lord's own Stager session is addressed by this exact name. It is a
 * Lord-run conversational role (AGENTS.md, "The Stager"), often created by
 * renaming a live pane rather than through create-agent, so it has no
 * per-agent ledger identity and therefore no roster `role` evidence —
 * observed live 2026-08-19, when the floor reported "zero live Stagers"
 * while the Lord's `stager` session was mid-conversation. The exact name is
 * itself presence evidence: herdr addressing is name-based and unique.
 */
const LORD_STAGER_NAME = "stager";

function isStagerCandidate(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
    (entry.role === "Stager" ||
      entry.name.toLowerCase() === LORD_STAGER_NAME ||
      entry.name.toLowerCase().startsWith("stager-"))
  );
}

/**
 * Whether a live candidate counts as a PRESENT Stager without further
 * evidence. Ledger role evidence always suffices; so does the Lord's
 * canonical `stager` name (which can never carry ledger role evidence, see
 * above). A `stager-*`-prefixed candidate without role evidence still
 * requires confirmation — those are spawned agents that must carry ledger
 * identity, and a stray similarly named pane must not satisfy the floor.
 */
function isConfirmedStager(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.role === "Stager" || entry.name.toLowerCase() === LORD_STAGER_NAME
  );
}

export function decideStagerFloorAction(
  desiredState: DesiredState,
  roster: readonly AgentStatusesRosterEntry[],
): StagerFloorDecision {
  if (desiredState === DESIRED_STATES.DISMISSED) return { action: "stay-down" };

  const candidates = roster.filter(isStagerCandidate);
  if (candidates.length > 1) {
    return {
      action: "refuse",
      failureKind: "evidence",
      reason: `ambiguous live Stager evidence: ${candidates.map(({ name }) => name).join(", ")}`,
    };
  }
  if (candidates.length === 0) return { action: "ensure" };
  const stager = candidates[0]!;
  if (!isConfirmedStager(stager)) {
    return {
      action: "refuse",
      failureKind: "evidence",
      reason: `live Stager candidate "${stager.name}" has unknown role evidence`,
    };
  }
  return { action: "present", name: stager.name };
}

function realPublishedRuntime():
  { readonly repoRoot: string; readonly cliEntrypoint: string } | undefined {
  const resolved = resolveRepoRootAndGenerationFromModuleUrl(import.meta.url);
  return resolved === undefined
    ? undefined
    : {
        repoRoot: resolved.repoRoot,
        cliEntrypoint: path.join(resolved.repoRoot, "dist", "src", "tools.js"),
      };
}

const REAL_STAGER_FLOOR_DEPENDENCIES: StagerFloorDependencies = {
  readDesiredState,
  readRoster: getAgentStatusesRoster,
  resolvePublishedRuntime: realPublishedRuntime,
  invokeCli: invokeThroneCliWithRetry,
  log: (message) => console.log(`[stager-floor] ${message}`),
};

function failureResult(
  outcome: Exclude<CliInvocationOutcome, { outcome: "success" }>,
) {
  return outcome.outcome === "retryable-failure-exhausted"
    ? outcome.lastResult
    : outcome.result;
}

async function invokeRequired(
  dependencies: StagerFloorDependencies,
  cliEntrypoint: string,
  argv: readonly string[],
  effect: string,
): Promise<string | undefined> {
  const outcome = await dependencies.invokeCli(process.execPath, [
    cliEntrypoint,
    ...argv,
  ]);
  if (outcome.outcome === "success") return outcome.result.stdout;
  const result = failureResult(outcome);
  dependencies.log(
    `LOUD FAILURE: ${effect} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
  return undefined;
}

export async function ensureLiveStager(
  dependencies: StagerFloorDependencies = REAL_STAGER_FLOOR_DEPENDENCIES,
): Promise<StagerFloorDecision> {
  let desiredState: DesiredState;
  let roster: readonly AgentStatusesRosterEntry[];
  try {
    desiredState = await dependencies.readDesiredState();
    roster = await dependencies.readRoster();
  } catch (error) {
    const refused = {
      action: "refuse",
      failureKind: "evidence",
      reason: `Stager evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    } as const;
    dependencies.log(`LOUD FAILURE: Stager evidence failure: ${refused.reason}`);
    return refused;
  }

  let decision: StagerFloorDecision;
  try {
    decision = decideStagerFloorAction(desiredState, roster);
  } catch (error) {
    const refused = {
      action: "refuse",
      failureKind: "decision",
      reason: `Stager decision failed: ${error instanceof Error ? error.message : String(error)}`,
    } as const;
    dependencies.log(`LOUD FAILURE: Stager decision failure: ${refused.reason}`);
    return refused;
  }

  if (decision.action === "stay-down") {
    dependencies.log("STAY DOWN: court desired-state is dismissed");
    return decision;
  }
  if (decision.action === "present") return decision;
  if (decision.action === "refuse") {
    dependencies.log(
      `LOUD FAILURE: Stager ${decision.failureKind} failure: ${decision.reason}; refusing to create a Stager`,
    );
    return decision;
  }

  dependencies.log(
    "floor breach: desired-state is running with zero live Stagers; ensuring now",
  );
  const runtime = dependencies.resolvePublishedRuntime();
  if (runtime === undefined) {
    const refused = {
      action: "refuse" as const,
      failureKind: "actuation" as const,
      reason: "could not resolve the published throne runtime",
    };
    dependencies.log(
      `LOUD FAILURE: ${refused.reason}; refusing to create a Stager`,
    );
    return refused;
  }
  const treeOutput = await invokeRequired(
    dependencies,
    runtime.cliEntrypoint,
    [
      "spawn-git-tree",
      STAGER_FLOOR_AGENT_NAME,
      "--repo",
      runtime.repoRoot,
      "--non-campaign",
    ],
    "Stager worktree preparation",
  );
  const cwd = treeOutput?.trim().split("\n").at(-1);
  if (!cwd)
    return {
      action: "refuse",
      failureKind: "actuation",
      reason: "Stager worktree preparation returned no cwd",
    };
  const created = await invokeRequired(
    dependencies,
    runtime.cliEntrypoint,
    [
      "create-agent",
      "--model",
      MODEL_NAMES.OPUS,
      "--role",
      "Stager",
      "--supervisor",
      "Regent",
      "--cwd",
      cwd,
      "--name",
      "floor",
      "--non-campaign",
    ],
    "Stager creation",
  );
  if (created === undefined)
    return {
      action: "refuse",
      failureKind: "actuation",
      reason: "Stager creation failed",
    };
  dependencies.log(
    `created "${STAGER_FLOOR_AGENT_NAME}" through the normal agent path`,
  );
  return decision;
}
