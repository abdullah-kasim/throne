import path from "node:path";
import type { Harness } from "../harness-routing/harness.ts";
import { resolveRegistryModel } from "../harness-routing/model-registry.ts";
import {
  treeNameFromPath,
  worktreesHome,
} from "../git-lifecycle/git-worktree.service.ts";
import {
  crossRolePrefixGuard,
  presetRoleCasingGate,
  presetRoleGate,
} from "../harness-routing/policy/admission.ts";
import { roleNameFor } from "./legacy-identity-data.service.ts";
import {
  type CreateAgentDeps,
  type CreateAgentRequest,
  type ParsedFlags,
  type StageResult,
} from "./create.types.ts";
import { stderrWriter } from "./command-context.ts";
import { canonicalIdentityName } from "../shared-identity/shared-identity.ts";
import { isTerminalAbsorbOrDeliveryShadowName } from "../merge-git-tree/terminal-gate-shadow.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import {
  harnessExecutableRefusal,
  parseFlags,
  splitPassthroughArgv,
} from "./request-arguments.ts";
export {
  harnessExecutableRefusal,
  parseFlags,
  splitPassthroughArgv,
} from "./request-arguments.ts";

const DEFAULT_ROLE = "Agent";

const USAGE =
  "Usage: ./bin/throne-cli create-agent-legacy --model <model> " +
  "[--effort <1-6>] --name <unique-name> " +
  "--supervisor <name> [--escalation <name>] [--role <role>] [--cwd <path>] " +
  "[--prompt <text>] [--requires <capability-expression>] " +
  "[--bypass-model (waives the role-pool pair-membership check only; requires " +
  "durable Regent-or-Lord authorization for an Alpha/Shadow recipient, or " +
  "Lord-only authorization for a Regent recipient)] [--bypass-zero-quota] " +
  "[--bypass-opencode-telemetry-unavailable] " +
  "[--objective-code <code> | --non-campaign] " +
  "[--empty-worktree] " +
  "[--deliverable-shape verdict-only (declares this agent's correct completion " +
  "is a judgement, not a diff; refused for a 99a/99e-shaped --name)] " +
  "[--bypass-effort] [--bypass-alpha-guardrail] [--bypass-preset-agent] " +
  "[--bypass-usage (pin the explicit route against usage steering; requires durable Lord or Regent authorization)] " +
  "[--harness-executable <absolute-path> [-- <complete harness argv…>]] " +
  "[--run-custom-harness-to-exit --clear-environment --env KEY=VALUE… " +
  "--stdout-path <path> --stderr-path <path> --exit-status-path <path> " +
  "--wall-time-path <path> --launcher-evidence-path <path> --timeout-ms <ms>]\n";

export function treeNameMismatch(
  resolvedCwd: string,
  storedName: string,
  home: string = worktreesHome(),
): { treeName: string } | undefined {
  const treeName = treeNameFromPath(resolvedCwd, home);
  if (treeName === undefined || treeName === storedName) {
    return undefined;
  }
  return { treeName };
}

function validateOneShotEnvironment(
  flags: ParsedFlags,
  writeStderr: (text: string) => void,
): boolean {
  const environmentNames = new Set<string>();
  for (const entry of flags.env ?? []) {
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      writeStderr(
        "create-agent-legacy: each --env for --run-custom-harness-to-exit must be KEY=VALUE with a portable environment name; values are not printed. Nothing was launched.\n",
      );
      return false;
    }
    if (environmentNames.has(name)) {
      writeStderr(
        `create-agent-legacy: duplicate --env key "${name}" is refused for --run-custom-harness-to-exit; values are not printed. Nothing was launched.\n`,
      );
      return false;
    }
    environmentNames.add(name);
  }
  return true;
}

function validateOneShotFlags(
  flags: ParsedFlags,
  requestedExecutable: string | undefined,
  writeStderr: (text: string) => void,
): boolean {
  if (requestedExecutable === undefined) {
    writeStderr(
      "create-agent-legacy: --run-custom-harness-to-exit requires --harness-executable. Nothing was launched.\n",
    );
    return false;
  }
  if (flags.prompt !== undefined) {
    writeStderr(
      'create-agent-legacy: --prompt is resident composer input and is refused with --run-custom-harness-to-exit; put native prompt tokens after "--". Nothing was launched.\n',
    );
    return false;
  }
  if (flags["clear-environment"] !== true) {
    writeStderr(
      "create-agent-legacy: --run-custom-harness-to-exit requires --clear-environment. Nothing was launched.\n",
    );
    return false;
  }
  const pathFlags = [
    "stdout-path",
    "stderr-path",
    "exit-status-path",
    "wall-time-path",
    "launcher-evidence-path",
  ] as const;
  const absent = pathFlags.filter((key) => flags[key] === undefined);
  if (absent.length > 0) {
    writeStderr(
      `create-agent-legacy: --run-custom-harness-to-exit requires ${absent.map((key) => `--${key}`).join(", ")}. Nothing was launched.\n`,
    );
    return false;
  }
  if (
    flags["timeout-ms"] === undefined ||
    !Number.isInteger(Number(flags["timeout-ms"])) ||
    Number(flags["timeout-ms"]) < 1
  ) {
    writeStderr(
      "create-agent-legacy: --run-custom-harness-to-exit requires --timeout-ms as a positive integer. Nothing was launched.\n",
    );
    return false;
  }
  return true;
}

export async function prepareCreateAgentRequest(
  args: string[],
  deps: CreateAgentDeps,
  repoRoot: string,
): Promise<StageResult<CreateAgentRequest>> {
  const writeStderr = stderrWriter(deps);
  let flags: ParsedFlags;
  let passthrough: string[] | undefined;
  try {
    const split = splitPassthroughArgv(args);
    passthrough = split.passthrough;
    const throneArgs = split.throneArgs;
    flags = parseFlags(throneArgs);
  } catch (error) {
    writeStderr(
      `create-agent-legacy: ${error instanceof Error ? error.message : String(error)}. ` +
        "Nothing was registered, trusted, routed, or launched.\n" +
        `${renderEntranceRefusal({
          reason:
            "create-agent entrance validation rejected the command syntax.",
          bypass: undefined,
          supervisorRoute:
            "Ask your supervisor for an allowed alternative invocation.",
        })}\n`,
    );
    return { ok: false, code: 1 };
  }
  if (flags.help === true) {
    (deps.writeStdout ?? ((text) => process.stdout.write(text)))(USAGE);
    return { ok: false, code: 0 };
  }
  if (flags.harness !== undefined) {
    writeStderr(
      "create-agent-legacy: --harness is no longer caller-selectable; infer the harness from the canonical model registry by passing --model. Exact registered resumes retain their stored harness. Nothing was registered or launched.\n",
    );
    return { ok: false, code: 1 };
  }
  const missing = (["model", "name", "supervisor"] as const).filter(
    (key) => flags[key] === undefined,
  );
  if (missing.length > 0) {
    writeStderr(
      `create-agent-legacy: missing required flag(s): ${missing
        .map((key) => `--${key}`)
        .join(", ")}\n${renderEntranceRefusal({
        reason:
          "create-agent entrance validation requires model, name, and supervisor flags.",
        bypass: undefined,
        supervisorRoute:
          "Ask your supervisor for an allowed alternative invocation.",
      })}\n${USAGE}`,
    );
    return { ok: false, code: 1 };
  }

  const oneShot = flags["run-custom-harness-to-exit"] === true;
  const oneShotOnlyFlags = [
    "clear-environment",
    "env",
    "stdout-path",
    "stderr-path",
    "exit-status-path",
    "wall-time-path",
    "launcher-evidence-path",
    "timeout-ms",
  ] as const;
  if (!oneShot) {
    const supplied = oneShotOnlyFlags.filter((key) => flags[key] !== undefined);
    if (supplied.length > 0) {
      writeStderr(
        `create-agent-legacy: ${supplied.map((key) => `--${key}`).join(", ")} require --run-custom-harness-to-exit. Nothing was registered or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
  } else if (!validateOneShotEnvironment(flags, writeStderr)) {
    return { ok: false, code: 1 };
  }

  let harness: Harness;
  let model: string;
  try {
    const entry = resolveRegistryModel(flags.model as string);
    harness = entry.harness;
    model = entry.model;
  } catch (error) {
    writeStderr(
      `create-agent-legacy: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { ok: false, code: 1 };
  }
  const requestedEffort =
    flags.effort === undefined ? undefined : Number(flags.effort);
  if (
    requestedEffort !== undefined &&
    (!Number.isInteger(requestedEffort) ||
      requestedEffort < 1 ||
      requestedEffort > 6)
  ) {
    writeStderr(
      `create-agent-legacy: --effort must be an integer 1–6 (got "${flags.effort}")\n`,
    );
    return { ok: false, code: 1 };
  }

  const requestedExecutable = flags["harness-executable"];
  if (passthrough !== undefined && requestedExecutable === undefined) {
    writeStderr(
      'create-agent-legacy: refusing a "--" passthrough argv without ' +
        '--harness-executable — the tokens after "--" are the custom harness ' +
        `executable's complete argv, and configured launchers take no ` +
        "passthrough. Nothing was registered or launched.\n",
    );
    return { ok: false, code: 1 };
  }
  if (requestedExecutable !== undefined) {
    const pathRefusal = await harnessExecutableRefusal(requestedExecutable);
    if (pathRefusal !== undefined) {
      writeStderr(
        `create-agent-legacy: ${pathRefusal}. Nothing was registered or launched.\n`,
      );
      return { ok: false, code: 1 };
    }
  }
  if (
    oneShot &&
    !validateOneShotFlags(flags, requestedExecutable, writeStderr)
  ) {
    return { ok: false, code: 1 };
  }

  const role = flags.role ?? DEFAULT_ROLE;
  const casingGate = presetRoleCasingGate({ role });
  if (casingGate.refuse) {
    writeStderr(
      `create-agent-legacy: ${casingGate.reason} Nothing was registered or launched.\n`,
    );
    return { ok: false, code: 1 };
  }
  const requestedName = flags.name as string;
  const name = oneShot ? requestedName : roleNameFor(role, requestedName);
  const presetGate = presetRoleGate({
    role,
    bypass: flags["bypass-preset-agent"] === true,
  });
  if (presetGate.refuse) {
    writeStderr(
      `create-agent-legacy: ${presetGate.reason}\n${renderEntranceRefusal({
        reason: "create-agent entrance validation refused a non-preset role.",
        bypass: "Pass --bypass-preset-agent for an ad-hoc agent.",
        supervisorRoute:
          "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return { ok: false, code: 1 };
  }
  const crossPrefix = crossRolePrefixGuard({ role, name: requestedName });
  if (crossPrefix.refuse) {
    writeStderr(
      `create-agent-legacy: refusing --role ${role} --name "${requestedName}" — the name ` +
        `already carries the "${crossPrefix.foreignPrefix}" role prefix, so the ` +
        `${role} prefix would double it to "${name}" (a reap name-correlation ` +
        `hazard). Use --name "${crossPrefix.cleaned}" (the role prefix is applied ` +
        `automatically) or the matching --role.\n`,
    );
    return { ok: false, code: 1 };
  }

  const emptyWorktree = flags["empty-worktree"] === true;
  const requestedCwd =
    flags.cwd ??
    (emptyWorktree ? path.join(worktreesHome(), "empty", name) : repoRoot);
  if (
    emptyWorktree &&
    role.trim().toLowerCase() !== "alpha" &&
    role.trim().toLowerCase() !== "shadow"
  ) {
    writeStderr(
      "create-agent-legacy: --empty-worktree is reserved for campaign Alpha or Shadow launches. Nothing was registered or launched.\n",
    );
    return { ok: false, code: 1 };
  }
  if (
    emptyWorktree &&
    flags.cwd !== undefined &&
    treeNameFromPath(requestedCwd) !== undefined
  ) {
    writeStderr(
      "create-agent-legacy: --empty-worktree cannot use a managed Git worktree --cwd; use the generated empty workspace path or omit --cwd. Nothing was registered or launched.\n",
    );
    return { ok: false, code: 1 };
  }
  // Applies to --run-custom-harness-to-exit too, not just resident spawns: a
  // disposable one-shot probe/canary is still a real live Herdr tab for the
  // duration of its run, and a --cwd borrowed from ANOTHER agent's worktree
  // gives reap-agent's occupancy guard (see reap-agent/occupancy.ts) the
  // exact live-third-party-in-the-tree hazard it exists to catch — the
  // observed CWD campaign incident. A one-shot probe's own scratch dir (the
  // documented pattern, e.g. `$CELL_HOME/work`) sits outside worktreesHome(),
  // so treeNameFromPath() there is undefined and this guard never fires for
  // the legitimate case.
  const mismatch =
    flags.cwd === undefined ? undefined : treeNameMismatch(requestedCwd, name);
  if (mismatch !== undefined) {
    writeStderr(
      `create-agent-legacy: refusing to spawn "${name}" inside git tree ` +
        `"${mismatch.treeName}" (${requestedCwd}) — that tree belongs to a ` +
        `DIFFERENT agent ("${mismatch.treeName}"). Borrowing another agent's ` +
        `worktree makes this spawn a live, unrelated occupant of it: if that ` +
        `agent is later reaped, its worktree is removed with this one still ` +
        `live inside it, and reap-agent's parentage check cannot see the ` +
        (oneShot
          ? `overlap (see reap-agent/occupancy.ts). Point --cwd at this probe's ` +
            `own scratch directory instead (outside ~/.throne/worktrees), or ` +
            `spawn it its own tree:\n`
          : `overlap (see reap-agent/occupancy.ts). Spawn the tree under the ` +
            `derived name, then repoint --cwd at it:\n`) +
        `  ./bin/throne-cli spawn-git-tree ${name} [--repo …]\n` +
        `  # then re-run create-agent with --cwd set to the path spawn-git-tree prints\n` +
        `Re-running with the current --cwd (the "${mismatch.treeName}" tree) ` +
        `trips this same guard. (create-agent derives "${name}" from --role ` +
        `${role} --name ${requestedName}; passing --name ${name} is equivalent — ` +
        `the role prefix is idempotent.)\n`,
    );
    return { ok: false, code: 1 };
  }

  const canonicalName = canonicalIdentityName(name);
  let deliverableShape: "verdict-only" | undefined;
  if (flags["deliverable-shape"] !== undefined) {
    if (flags["deliverable-shape"] !== "verdict-only") {
      writeStderr(
        `create-agent-legacy: --deliverable-shape "${flags["deliverable-shape"]}" is refused — ` +
          'the only accepted value is "verdict-only". Nothing was registered or launched.\n' +
          `${renderEntranceRefusal({
            reason:
              "create-agent entrance validation rejected an invalid --deliverable-shape value.",
            bypass: undefined,
            supervisorRoute:
              "Ask your supervisor for an allowed alternative invocation.",
          })}\n`,
      );
      return { ok: false, code: 1 };
    }
    if (isTerminalAbsorbOrDeliveryShadowName(canonicalName)) {
      writeStderr(
        `create-agent-legacy: --deliverable-shape verdict-only is refused for "${canonicalName}" — ` +
          "a 99a (absorb) or 99e (delivery) terminal-gate slice legitimately produces a " +
          "commit, so it must never carry the no-diff-expected declaration. Nothing was " +
          "registered or launched.\n",
      );
      return { ok: false, code: 1 };
    }
    deliverableShape = "verdict-only";
  }

  return {
    ok: true,
    value: {
      flags,
      passthrough,
      oneShot,
      harness: harness as Harness,
      model,
      requestedEffort,
      requestedExecutable,
      role,
      requestedName,
      name: canonicalName,
      requestedCwd,
      emptyWorktree,
      ...(deliverableShape === undefined ? {} : { deliverableShape }),
    },
  };
}
