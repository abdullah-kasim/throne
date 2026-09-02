import {
  HARNESS_NAMES,
  MODEL_NAMES,
  isGptModel,
  type Harness,
  type RuntimeHarness,
} from "./harness-routing/harness.ts";
import {
  MODEL_REGISTRY,
  MODEL_ROLES,
  registryEntry,
  type ModelRole,
} from "./harness-routing/model-registry.ts";
import { deriveHarnessAvailability } from "./harness-routing/registry-derivation.ts";
import {
  LIVE_ROLE_WORD_UNION,
  resolveCanonicalRoleWord,
} from "./shared-policy/role-word-union.ts";
import {
  PLAN_PRESET_NAMES,
  activeCustomPlanPresets,
  activePlanPresetName,
  activeStagerPool,
  activeHarness,
  activeTargetEffort,
  type BuiltinPlanPresetName,
  type CustomPlanPresetPair,
  type PlanPresetName,
} from "./steering-user-config.ts";

export {
  PLAN_PRESET_NAMES,
  activeHarness,
  activePlanPresetName,
  activeTargetEffort,
  type BuiltinPlanPresetName,
  type PlanPresetName,
};

export const PLAN_ROLES: readonly ModelRole[] = Object.values(MODEL_ROLES);
export type PlanRole = ModelRole;

export interface ModelPair {
  readonly harness: Harness;
  readonly model: string;
}

/** Normalize a forward GPT request onto its `MODEL_REGISTRY`-declared primary
 *  harness, the row existing role pools and steering policy key off. */
export function canonicalForwardModelPair(
  pair: ModelPair,
): ModelPair | undefined {
  if (!isGptModel(pair.model)) return pair;
  const primaryHarness = registryEntry(pair.model)?.harness;
  if (primaryHarness === undefined) return undefined;
  return { harness: primaryHarness, model: pair.model };
}

/** The harness fresh GPT model spawns forward through, per `MODEL_REGISTRY`'s
 *  own declaration for a registered GPT model — not a selectable policy. */
export const GPT_FORWARD_HARNESS: Harness = (() => {
  const pair = canonicalForwardModelPair({
    harness: HARNESS_NAMES.CLAUDE,
    model: MODEL_NAMES.GPT_5_6_SOL,
  });
  if (pair === undefined) {
    throw new Error(
      "MODEL_REGISTRY declares no forward harness for GPT models",
    );
  }
  return pair.harness;
})();

export type ModelPairPool = readonly ModelPair[];
export type PlanRolePools = Readonly<Record<PlanRole, ModelPairPool>>;

export interface PlanPreset {
  readonly name: PlanPresetName;
  readonly rolePools: PlanRolePools;
}

const HARNESS_AVAILABILITY = deriveHarnessAvailability(MODEL_REGISTRY);

const VALID_MODEL_PAIRS: ModelPairPool = (
  Object.keys(HARNESS_AVAILABILITY) as RuntimeHarness[]
).flatMap((harness) =>
  HARNESS_AVAILABILITY[harness].map((model) => ({ harness, model })),
);

/** Claude-harness GPT rows stay outside canonical role-pool and steering pairs,
 *  but remain fresh forward candidates when the selected GPT policy is
 *  `ClaudeCode`; exact stored recipes still relaunch unchanged. */
export const LEGACY_RESUME_ONLY_MODEL_PAIRS: ModelPairPool =
  VALID_MODEL_PAIRS.filter(
    ({ harness, model }) =>
      harness === HARNESS_NAMES.CLAUDE && isGptModel(model),
  );

/** Every pair the throne may select for a genuinely new spawn. */
export const CONFIGURED_MODEL_PAIRS: ModelPairPool = VALID_MODEL_PAIRS.filter(
  (pair) =>
    (pair.harness === HARNESS_NAMES.CLAUDE ||
      pair.harness === HARNESS_NAMES.CODEX ||
      pair.harness === HARNESS_NAMES.OPENCODE ||
      pair.harness === HARNESS_NAMES.OMP) &&
    !modelPairInPool(LEGACY_RESUME_ONLY_MODEL_PAIRS, pair),
);

const CODEX_MODEL_PAIRS = CONFIGURED_MODEL_PAIRS.filter(
  ({ harness }) => harness === HARNESS_NAMES.CODEX,
);

const ANTHROPIC_MODEL_PAIRS = CONFIGURED_MODEL_PAIRS.filter(
  ({ harness, model }) =>
    harness === HARNESS_NAMES.CLAUDE && !isGptModel(model),
);

const CODEX_SOL_PAIR: ModelPair = {
  harness: HARNESS_NAMES.CODEX,
  model: MODEL_NAMES.GPT_5_6_SOL,
};
const CODEX_LUNA_PAIR: ModelPair = {
  harness: HARNESS_NAMES.CODEX,
  model: MODEL_NAMES.GPT_5_6_LUNA,
};
const CLAUDE_SONNET_PAIR: ModelPair = {
  harness: HARNESS_NAMES.CLAUDE,
  model: MODEL_NAMES.SONNET,
};
const CLAUDE_FABLE_PAIR: ModelPair = {
  harness: HARNESS_NAMES.CLAUDE,
  model: MODEL_NAMES.FABLE,
};
const CLAUDE_OPUS_PAIR: ModelPair = {
  harness: HARNESS_NAMES.CLAUDE,
  model: MODEL_NAMES.OPUS,
};

const CODEX_SOL: ModelPairPool = [CODEX_SOL_PAIR];
const CODEX_LUNA: ModelPairPool = [CODEX_LUNA_PAIR];
const CLAUDE_SONNET: ModelPairPool = [CLAUDE_SONNET_PAIR];

const CLAUDE_FABLE_OPUS: ModelPairPool = [CLAUDE_FABLE_PAIR, CLAUDE_OPUS_PAIR];

/** The Stager's pool: the operator's `steering.stagerPool` if present,
 *  otherwise the committed claude/opus pin. Validated against the canonical
 *  pair table exactly like a custom preset pool — a typo refuses the config
 *  rather than silently spawning the Lord a different Stager. */
const STAGER_POOL: ModelPairPool = (() => {
  const configured = activeStagerPool();
  if (configured === undefined) return [CLAUDE_OPUS_PAIR];
  return materializeCustomPool("stagerPool", "stagerPool", configured);
})();

/** Every role pool here derives from the preset's `alpha`/`shadow` inputs
 *  except `Stager`, which is a fixed pair list independent of them — see the
 *  comment on that field below. */
function rolePools(
  alpha: ModelPairPool,
  shadow: ModelPairPool,
  shadowSlice99: ModelPairPool,
): PlanRolePools {
  return {
    Alpha: alpha,
    Shadow: shadow,
    ShadowSlice99: shadowSlice99,
    // The Stager is NOT derived from `alpha` — deriving it would yield
    // Sonnet-only under `UnifiedRouting`, and would let any campaign preset
    // switch move the Lord's point of contact as a side effect. Do not
    // "fix" this back to a derived pool for consistency with its neighbours.
    // It is the committed Opus pin unless `config.user.ts` names an explicit
    // `steering.stagerPool` — one deliberate field, read nowhere else.
    Stager: STAGER_POOL,
  };
}

export const PLAN_PRESETS: Readonly<Record<BuiltinPlanPresetName, PlanPreset>> =
  {
    GptOnly: {
      name: "GptOnly",
      // The Lord's order of 2026-08-17: sol low end to end — ordinary slice
      // Shadows included, not just Alpha and the terminal 99a-99e gates. The
      // wider Codex pool here previously let steering hand a slice Shadow
      // gpt-5.6-luna (observed: shadow-steerall-01).
      rolePools: rolePools(CODEX_SOL, CODEX_SOL, CODEX_SOL),
    },
    AnthropicOnly: {
      name: "AnthropicOnly",
      rolePools: rolePools(
        CLAUDE_FABLE_OPUS,
        ANTHROPIC_MODEL_PAIRS,
        CLAUDE_FABLE_OPUS,
      ),
    },
    Optimized: {
      name: "Optimized",
      rolePools: rolePools(
        CLAUDE_FABLE_OPUS,
        CODEX_MODEL_PAIRS,
        CLAUDE_FABLE_OPUS,
      ),
    },
    Whichever: {
      name: "Whichever",
      rolePools: rolePools(
        CONFIGURED_MODEL_PAIRS,
        CONFIGURED_MODEL_PAIRS,
        CONFIGURED_MODEL_PAIRS,
      ),
    },
    /** The active unified route is deliberately Sonnet-only for every campaign
     *  role. Other registered rows remain available only through an explicit,
     *  separately authorized policy change rather than usage/model steering. */
    UnifiedRouting: {
      name: "UnifiedRouting",
      rolePools: rolePools(CLAUDE_SONNET, CLAUDE_SONNET, CLAUDE_SONNET),
    },
  };

/** Materializes one operator-authored pool — a custom preset's pool or the
 *  Stager pool: every literal pair must be a canonical configured pair
 *  (registered harness/model, not legacy resume-only) or the whole config is
 *  refused at load — a typo'd model in `config.user.ts` must never silently
 *  spawn something else. `sourceLabel` names where the pool came from so the
 *  refusal points at the right line of the operator's file. */
function materializeCustomPool(
  sourceLabel: string,
  poolName: string,
  pairs: readonly CustomPlanPresetPair[],
): ModelPairPool {
  return pairs.map((pair) => {
    const canonical = CONFIGURED_MODEL_PAIRS.find(
      ({ harness, model }) => harness === pair.harness && model === pair.model,
    );
    if (canonical === undefined) {
      throw new Error(
        `Invalid config.user.ts steering entry "${sourceLabel}": ${poolName} pair ` +
          `${pair.harness}/${pair.model} is not a configured spawnable pair. ` +
          `Configured pairs: ${CONFIGURED_MODEL_PAIRS.map((p) => `${p.harness}/${p.model}`).join(", ")}.`,
      );
    }
    return canonical;
  });
}

/** The operator's `config.user.ts` custom presets, materialized once against
 *  the canonical pair table. A custom preset defines only the three
 *  campaign-role pools; the Stager comes from `steering.stagerPool`. */
const CUSTOM_PLAN_PRESETS: Readonly<Record<string, PlanPreset>> =
  Object.fromEntries(
    Object.entries(activeCustomPlanPresets()).map(([name, pools]) => [
      name,
      {
        name,
        rolePools: rolePools(
          materializeCustomPool(name, "alpha", pools.alpha),
          materializeCustomPool(name, "shadow", pools.shadow),
          materializeCustomPool(name, "shadowSlice99", pools.shadowSlice99),
        ),
      },
    ]),
  );

/** The sole preset lookup: built-ins first, then the operator's custom
 *  presets. Throws on a name that resolves to neither — steering-user-config
 *  already refuses such a name at load, so this throw marks an internal
 *  inconsistency, not an operator mistake. */
/**
 * Rewrites every campaign role's pool onto one harness, leaving the models
 * exactly as the preset named them.
 *
 * A pool pair carries a harness AND a model, which made the two decisions
 * inseparable: moving harness meant rewriting every pool, and rewriting a
 * pool to move harness is how the model pin was lost on 2026-08-26 — the
 * single-entry pool that had been holding the model was widened in the same
 * edit, and the next spawn came up on the most expensive model available for
 * a task whose whole deliverable was one sentence. "Which models" and "which
 * harness" are now separate settings because they are separate decisions.
 *
 * FAIL CLOSED. A model the target harness cannot run is a hard error naming
 * both, never a silent fall back to the pair's original harness — falling
 * back would mean a config that says "everything on X" quietly running some
 * roles on Y, which is worse than refusing to start.
 *
 * The Stager is untouched: its pool comes from `STAGER_POOL` on standing
 * order, independent of every preset, and a harness override is no more
 * entitled to move it than a preset is. Moving the Stager is a separate,
 * explicit `steering.stagerPool` decision.
 */
function applyHarnessOverride(
  preset: PlanPreset,
  harness: string | undefined,
): PlanPreset {
  if (harness === undefined) return preset;
  const retarget = (pool: ModelPairPool, role: string): ModelPairPool =>
    pool.map((pair) => {
      const moved: ModelPair = { harness: harness as Harness, model: pair.model };
      if (!modelPairInPool(CONFIGURED_MODEL_PAIRS, moved)) {
        throw new Error(
          `activeHarness "${harness}" cannot run "${pair.model}" (needed for ` +
            `role ${role} in preset "${preset.name}"). Either pick models that ` +
            `harness supports, or drop activeHarness and let each pair use its ` +
            `own harness. Refusing to fall back to ${pair.harness}/${pair.model}: ` +
            `a config that says everything runs on one harness must not quietly ` +
            `run part of the court on another.`,
        );
      }
      return moved;
    });
  return {
    name: preset.name,
    rolePools: {
      ...preset.rolePools,
      Alpha: retarget(preset.rolePools.Alpha, "Alpha"),
      Shadow: retarget(preset.rolePools.Shadow, "Shadow"),
      ShadowSlice99: retarget(preset.rolePools.ShadowSlice99, "ShadowSlice99"),
    },
  };
}

export function resolvePlanPreset(name: PlanPresetName): PlanPreset {
  const builtin = (PLAN_PRESETS as Readonly<Record<string, PlanPreset>>)[name];
  if (builtin !== undefined) return applyHarnessOverride(builtin, activeHarness());
  const custom = CUSTOM_PLAN_PRESETS[name];
  if (custom !== undefined) return applyHarnessOverride(custom, activeHarness());
  throw new Error(
    `Unknown plan preset "${name}" (built-ins: ${PLAN_PRESET_NAMES.join(", ")}; customs: ${Object.keys(CUSTOM_PLAN_PRESETS).join(", ") || "none"}).`,
  );
}

export const ACTIVE_PLAN_PRESET: PlanPreset = resolvePlanPreset(
  activePlanPresetName(),
);

export interface ModelEffortRange {
  readonly min: number;
  readonly max: number;
}

/** Resolves the ordinary fresh effort for a model: the target clamped into the
 *  model's registered available range. Throws on a structurally invalid
 *  target or range. */
export function resolveTargetEffort(
  target: number,
  range: ModelEffortRange,
): number {
  if (!Number.isInteger(target) || target < 1) {
    throw new RangeError(
      `target effort must be an integer >= 1 (got ${target})`,
    );
  }
  if (range.min > range.max) {
    throw new RangeError(
      `effort range minimum ${range.min} exceeds maximum ${range.max}`,
    );
  }
  return Math.max(range.min, Math.min(target, range.max));
}

resolveTargetEffort(activeTargetEffort(), { min: 1, max: 6 });

export function isShadowSlice99Name(
  name: string,
  objectiveCode?: string,
): boolean {
  const resolved = resolveCanonicalRoleWord(
    name.trim().toLowerCase(),
    LIVE_ROLE_WORD_UNION,
  );
  if (resolved?.role !== "shadow") return false;
  if (objectiveCode !== undefined) {
    const canonicalCode = objectiveCode.trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(canonicalCode)) return false;
    const campaignPrefix = `${canonicalCode}-`;
    return (
      resolved.rest.startsWith(campaignPrefix) &&
      /^99(?:a|b|c|d)?(?:$|[-_])/.test(
        resolved.rest.slice(campaignPrefix.length),
      )
    );
  }
  return /^(?:[a-z0-9]+-)?99(?:a|b|c|d)?(?:$|[-_])/.test(resolved.rest);
}

export function classifyPlanRole(
  role: string,
  finalName?: string,
  objectiveCode?: string,
): PlanRole | undefined {
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "alpha") return "Alpha";
  if (normalizedRole === "stager") return "Stager";
  if (normalizedRole !== "shadow") return undefined;
  return finalName !== undefined &&
    isShadowSlice99Name(finalName, objectiveCode)
    ? "ShadowSlice99"
    : "Shadow";
}

export function planRolePool(
  role: PlanRole,
  preset: PlanPresetName = activePlanPresetName(),
): ModelPairPool {
  return resolvePlanPreset(preset).rolePools[role];
}

export function modelPairInPool(pool: ModelPairPool, pair: ModelPair): boolean {
  return pool.some(
    ({ harness, model }) => harness === pair.harness && model === pair.model,
  );
}

export function isLegacyResumeOnlyModelPair(pair: ModelPair): boolean {
  return modelPairInPool(LEGACY_RESUME_ONLY_MODEL_PAIRS, pair);
}

export function filterModelPairsByHarness(
  pool: ModelPairPool,
  harness: Harness,
): ModelPairPool {
  return pool.filter((pair) => pair.harness === harness);
}

export function configuredModelCandidate(
  pair: ModelPair,
): ModelPair | undefined {
  return modelPairInPool(CONFIGURED_MODEL_PAIRS, pair) ? pair : undefined;
}

export function preferredModelCandidate(
  candidates: ModelPairPool,
  preferred?: ModelPair,
): ModelPair | undefined {
  const configuredCandidates = candidates.filter((candidate) =>
    modelPairInPool(CONFIGURED_MODEL_PAIRS, candidate),
  );
  if (preferred !== undefined) {
    const match = configuredCandidates.find(
      ({ harness, model }) =>
        harness === preferred.harness && model === preferred.model,
    );
    if (match !== undefined) return match;
  }
  return configuredCandidates[0];
}
