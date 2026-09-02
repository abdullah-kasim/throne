import { HarnessRegistryService } from "./harness-registry.service.ts";
import type {
  ActivePlanStatus,
  ForwardLaunchPolicyStatus,
  HarnessEntry,
} from "./harness-catalog.contracts.ts";
import {
  activePlanPresetName,
  classifyPlanRole,
  planRolePool,
  type ModelPair,
  type ModelPairPool,
  type PlanRole,
} from "../config.ts";
import { resolveSpawnAdmission } from "../harness-routing/policy/admission.ts";
import { parseQueueModelHint } from "../regent-queue/model-hint.ts";

export interface ModelPresentationDeps {
  out: (text: string) => void;
}

function parsePair(value: string, flag: string): ModelPair {
  const [harness, model, extra] = value.trim().split("/");
  if (harness === undefined || model === undefined || extra !== undefined) {
    throw new Error(`${flag} must be a harness/model pair: ${value}`);
  }
  return { harness: harness as ModelPair["harness"], model };
}

function parseAdmissionFlags(
  args: readonly string[],
): {
  role: string;
  model?: string;
  name: string;
  modelHint?: string;
  allowedPair: string[];
} {
  const parsed: Record<string, string | string[]> = { allowedPair: [] };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--role") parsed.role = args[++index] ?? "";
    else if (token === "--model") parsed.model = args[++index] ?? "";
    else if (token === "--name") parsed.name = args[++index] ?? "";
    else if (token === "--model-hint") parsed.modelHint = args[++index] ?? "";
    else if (token === "--allowed-pair")
      (parsed.allowedPair as string[]).push(args[++index] ?? "");
  }
  if (typeof parsed.role !== "string" || parsed.role === "")
    throw new Error("--check-admission requires --role");
  if (typeof parsed.name !== "string" || parsed.name === "")
    throw new Error("--check-admission requires --name");
  return {
    role: parsed.role,
    model: parsed.model as string | undefined,
    name: parsed.name,
    modelHint: parsed.modelHint as string | undefined,
    allowedPair: parsed.allowedPair as string[],
  };
}

function resolveAdmissionPlanRole(role: string, name: string): PlanRole | undefined {
  if (role.trim().toLowerCase() === "shadowslice99") return "ShadowSlice99";
  return classifyPlanRole(role, name);
}

export function resolveAdmissionCheck(args: readonly string[]) {
  const flags = parseAdmissionFlags(args);
  const modelHint = parseQueueModelHint(flags.modelHint);
  const requested =
    modelHint ??
    (flags.model !== undefined ? parsePair(flags.model, "--model") : undefined);
  if (requested === undefined)
    throw new Error("--check-admission requires --model-hint or --model");
  const preset = activePlanPresetName();
  const planRole = resolveAdmissionPlanRole(flags.role, flags.name);
  const allowedPairs: ModelPairPool | undefined =
    flags.allowedPair.length > 0
      ? flags.allowedPair.map((pair) => parsePair(pair, "--allowed-pair"))
      : planRole !== undefined
        ? planRolePool(planRole, preset)
        : undefined;
  return resolveSpawnAdmission({
    requested,
    planRole,
    preset,
    name: flags.name,
    allowedPairs,
    enforceRolePool: true,
  });
}

export function buildActivePlanStatus(): ActivePlanStatus {
  return new HarnessRegistryService().activePlan();
}
export function buildForwardLaunchPolicyStatus(): ForwardLaunchPolicyStatus {
  return new HarnessRegistryService().forwardLaunchPolicy();
}
export function buildRegistry(): HarnessEntry[] {
  return new HarnessRegistryService().entries();
}

export class ModelPresentationService {
  private readonly registry: HarnessRegistryService;

  constructor(registry: HarnessRegistryService = new HarnessRegistryService()) {
    this.registry = registry;
  }

  render(args: readonly string[], deps: ModelPresentationDeps): number {
    const harnesses = this.registry.entries();
    const activePlan = this.registry.activePlan();
    const forwardPolicy = this.registry.forwardLaunchPolicy();
    if (args.includes("--check-admission")) {
      let admission;
      try {
        admission = resolveAdmissionCheck(args);
      } catch (error) {
        deps.out(
          `list-harnesses-and-models: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
      if (args.includes("--json")) {
        deps.out(
          `${JSON.stringify({ source: "list-harnesses-and-models", active_plan: activePlan, harnesses, forward_launch_policy: forwardPolicy, admission })}\n`,
        );
        return admission.kind === "admit" ? 0 : 1;
      }
      deps.out(`${JSON.stringify(admission)}\n`);
      return admission.kind === "admit" ? 0 : 1;
    }
    if (args.includes("--json")) {
      deps.out(
        `${JSON.stringify({ source: "list-harnesses-and-models", active_plan: activePlan, harnesses, forward_launch_policy: forwardPolicy })}\n`,
      );
      return 0;
    }
    deps.out(
      "Harnesses and models — static registry (no live usage; see plan-usage-remaining for quota)\n\n",
    );
    deps.out(`Active plan:\n  preset: ${activePlan.preset}\n`);
    for (const role of Object.keys(activePlan.rolePools) as Array<
      keyof typeof activePlan.rolePools
    >) {
      deps.out(
        `  ${role}: ${activePlan.rolePools[role].map(({ harness, model }) => `${harness}/${model}`).join(", ")}\n`,
      );
    }
    deps.out(
      `\nForward launch policy:\n  GPT path: ${forwardPolicy.gptHarness}/${forwardPolicy.gptLauncher}\n`,
    );
    for (const entry of harnesses) {
      deps.out(`\n${entry.harness}:\n`);
      for (const model of entry.models)
        deps.out(
          `  ${model.model}  ${model.launcher}  ${model.launchPolicy}\n`,
        );
    }
    return 0;
  }
}
