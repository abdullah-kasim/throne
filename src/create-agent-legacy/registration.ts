import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { type SpawnSpec } from "./legacy-spawn-data-contracts.ts";
import { LedgerDataService } from "./legacy-ledger-data.service.ts";
import {
  HARNESSES,
  resolveModel,
  type Harness,
} from "../harness-routing/harness.ts";
import {
  AgentResolutionError,
  type HerdrAgent,
} from "./legacy-herdr-identity-contracts.ts";
import { herdrAgentNameRefusal } from "../herdr/herdr-identity.service.ts";
import { explicitResumeObjectiveConflict } from "../shared-policy/objective-contract.ts";
import {
  type CreateAgentDeps,
  type CreateAgentRequest,
  type RegistrationResolution,
  type StageResult,
} from "./create.types.ts";
import { stderrWriter } from "./command-context.ts";

const ledgerData = new LedgerDataService();

export const POST_SPAWN_RESOLVE_ATTEMPTS = 31;
export const POST_SPAWN_RESOLVE_POLL_MS = 100;

export function customRecipeResumeConflict(opts: {
  requestedExecutable?: string;
  requestedPassthrough?: readonly string[];
  storedExecutable?: string;
  storedPassthrough?: readonly string[];
}): string | undefined {
  if (
    opts.requestedExecutable === undefined &&
    opts.requestedPassthrough === undefined
  ) {
    return undefined;
  }
  if (opts.storedExecutable === undefined) {
    return (
      "its stored spawn spec records no custom harness executable, and a " +
      "registered dead resume accepts no new custom recipe"
    );
  }
  if (
    opts.requestedExecutable !== undefined &&
    opts.requestedExecutable !== opts.storedExecutable
  ) {
    return (
      `the requested --harness-executable "${opts.requestedExecutable}" does ` +
      `not exactly match the stored "${opts.storedExecutable}"`
    );
  }
  if (opts.requestedPassthrough !== undefined) {
    const stored = opts.storedPassthrough ?? [];
    const matches =
      opts.requestedPassthrough.length === stored.length &&
      opts.requestedPassthrough.every(
        (token, index) => token === stored[index],
      );
    if (!matches) {
      return (
        `the requested passthrough argv ${JSON.stringify(opts.requestedPassthrough)} ` +
        `does not exactly match the stored ${JSON.stringify(stored)}`
      );
    }
  }
  return undefined;
}

export async function removeRegistration(
  name: string,
  baseDir?: string,
): Promise<void> {
  const dir =
    baseDir === undefined
      ? ledgerData.agentDir(name)
      : path.join(baseDir, name);
  await Promise.all([
    rm(path.join(dir, "identity.md"), { force: true }),
    rm(path.join(dir, "opening-prompt.md"), { force: true }),
    rm(path.join(dir, "spawn.json"), { force: true }),
  ]);
  await rmdir(dir).catch(() => undefined);
}

async function nameIsTaken(
  name: string,
  deps: CreateAgentDeps,
): Promise<boolean> {
  if (await deps.registrationExists(name)) {
    return true;
  }
  try {
    await deps.resolveAgent(name);
    return true;
  } catch (error) {
    if (error instanceof AgentResolutionError && error.matchCount === 0) {
      return false;
    }
    throw error;
  }
}

function usableSpawnSpec(spec: SpawnSpec | null):
  | {
      harness: Harness;
      model: string;
      effort: number;
      cwd: string;
      evidence: SpawnSpec;
    }
  | undefined {
  if (
    spec === null ||
    !HARNESSES.includes(spec.harness as Harness) ||
    !Number.isInteger(spec.effort) ||
    spec.effort < 1 ||
    spec.effort > 6 ||
    spec.cwd.trim() === ""
  ) {
    return undefined;
  }
  const harness = spec.harness as Harness;
  try {
    return {
      harness,
      model: resolveModel(harness, spec.model),
      effort: spec.effort,
      cwd: spec.cwd,
      evidence: spec,
    };
  } catch {
    return undefined;
  }
}

export async function resolveSpawnedAgent(
  name: string,
  deps: CreateAgentDeps,
): Promise<HerdrAgent | undefined> {
  for (let attempt = 1; attempt <= POST_SPAWN_RESOLVE_ATTEMPTS; attempt++) {
    try {
      return await deps.resolveAgent(name);
    } catch (error) {
      if (!(error instanceof AgentResolutionError) || error.matchCount !== 0) {
        throw error;
      }
      if (attempt < POST_SPAWN_RESOLVE_ATTEMPTS) {
        await deps.sleep(POST_SPAWN_RESOLVE_POLL_MS);
      }
    }
  }
  return undefined;
}

function freshRegistration(
  request: CreateAgentRequest,
): RegistrationResolution {
  return {
    ...request,
    launchHarness: request.harness,
    launchModel: request.model,
    launchEffort: request.requestedEffort,
    cwd: request.requestedCwd,
    resuming: false,
    customExecutable: request.requestedExecutable,
    customPassthrough: request.passthrough ?? [],
    emptyWorktree: request.emptyWorktree,
  };
}

function explicitResumeConflicts(
  request: CreateAgentRequest,
  stored: {
    harness: Harness;
    model: string;
    effort: number;
    cwd: string;
  },
): string[] {
  const requestedValues: Record<string, string | number> = {
    model: request.model,
  };
  if (request.requestedEffort !== undefined) {
    requestedValues.effort = request.requestedEffort;
  }
  const storedValues: Record<string, string | number> = {
    harness: stored.harness,
    model: stored.model,
    effort: stored.effort,
  };
  if (request.flags.cwd !== undefined) {
    requestedValues.cwd = request.requestedCwd;
    storedValues.cwd = stored.cwd;
  }
  return Object.keys(requestedValues)
    .filter((key) => requestedValues[key] !== storedValues[key])
    .map(
      (key) =>
        `  ${key}: stored="${storedValues[key]}" requested="${requestedValues[key]}"`,
    );
}

export async function resolveRegistration(
  request: CreateAgentRequest,
  deps: CreateAgentDeps,
): Promise<StageResult<RegistrationResolution>> {
  const writeStderr = stderrWriter(deps);
  const nameTaken = request.oneShot
    ? false
    : await nameIsTaken(request.name, deps);
  if (!nameTaken) {
    const nameRefusal = herdrAgentNameRefusal(request.name);
    if (nameRefusal !== undefined) {
      writeStderr(
        `create-agent-legacy: refusing fresh agent — ${nameRefusal}. Nothing was registered or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
    return { ok: true, value: freshRegistration(request) };
  }
  if (!(await deps.registrationExists(request.name))) {
    writeStderr(
      `create-agent-legacy: an agent named "${request.name}" already exists — names must be ` +
        `unique so later resolution is unambiguous\n`,
    );
    return { ok: false, code: 1 };
  }

  const runningAgent = await resolveSpawnedAgent(request.name, deps);
  if (runningAgent !== undefined) {
    writeStderr(
      `create-agent-legacy: registered agent "${request.name}" is already running — refusing ` +
        `to launch a second pane. Inspect it with ` +
        `./bin/throne-cli agent-logs ${request.name} --source visible or tear it down ` +
        `with ./bin/throne-cli reap-agent ${request.name} --force --reason force.\n`,
    );
    return { ok: false, code: 1 };
  }

  const storedSpec = await deps.readSpawnSpec(request.name);
  const stored = usableSpawnSpec(storedSpec);
  if (stored === undefined) {
    writeStderr(
      `create-agent-legacy: registered agent "${request.name}" has a missing, corrupt, or ` +
        `unusable spawn spec — refusing to resume it by guessing. Tear the ` +
        `registration down with ./bin/throne-cli reap-agent ${request.name} --reason error, then ` +
        `create it again.\n`,
    );
    return { ok: false, code: 1 };
  }

  const conflicts = explicitResumeConflicts(request, stored);
  if (conflicts.length > 0) {
    writeStderr(
      `create-agent-legacy: refusing to resume registered agent "${request.name}" because ` +
        `explicit re-run flags conflict with its stored spawn spec:\n` +
        conflicts.join("\n") +
        `\nRe-run with the stored values or tear it down with ` +
        `./bin/throne-cli reap-agent ${request.name} --reason superseded.\n`,
    );
    return { ok: false, code: 1 };
  }

  const objectiveConflict = explicitResumeObjectiveConflict({
    objectiveCode: request.flags["objective-code"],
    nonCampaign: request.flags["non-campaign"] === true,
    storedEvidence: stored.evidence,
  });
  if (objectiveConflict !== undefined) {
    writeStderr(
      `create-agent-legacy: refusing to resume registered agent "${request.name}" because ` +
        `${objectiveConflict}. Re-run without the conflicting objective flag ` +
        `or tear it down with ./bin/throne-cli reap-agent ${request.name} ` +
        `--reason superseded.\n`,
    );
    return { ok: false, code: 1 };
  }

  const customConflict = customRecipeResumeConflict({
    requestedExecutable: request.requestedExecutable,
    requestedPassthrough: request.passthrough,
    storedExecutable: stored.evidence.harness_executable,
    storedPassthrough: stored.evidence.passthrough_argv,
  });
  if (customConflict !== undefined) {
    writeStderr(
      `create-agent-legacy: refusing to resume registered agent "${request.name}" because ` +
        `${customConflict}. Re-run with the stored recipe (or omit the custom ` +
        `recipe flags to resume it exactly), or tear it down with ` +
        `./bin/throne-cli reap-agent ${request.name} --reason superseded.\n`,
    );
    return { ok: false, code: 1 };
  }

  return {
    ok: true,
    value: {
      ...request,
      flags: {
        ...request.flags,
        ...(stored.evidence.objective_code === undefined
          ? {}
          : { "objective-code": stored.evidence.objective_code }),
        ...(stored.evidence.non_campaign === true
          ? { "non-campaign": true }
          : {}),
        ...(stored.evidence.empty_worktree === true
          ? { "empty-worktree": true }
          : {}),
      },
      objectiveContract:
        stored.evidence.objective_code === undefined
          ? stored.evidence.non_campaign === true
            ? { kind: "non-campaign" as const }
            : undefined
          : {
              kind: "campaign" as const,
              objectiveCode: stored.evidence.objective_code,
            },
      launchHarness: stored.harness,
      launchModel: stored.model,
      launchEffort: stored.effort,
      cwd: stored.cwd,
      resuming: true,
      customExecutable: stored.evidence.harness_executable,
      customPassthrough: stored.evidence.passthrough_argv ?? [],
      emptyWorktree: stored.evidence.empty_worktree === true,
    },
  };
}
