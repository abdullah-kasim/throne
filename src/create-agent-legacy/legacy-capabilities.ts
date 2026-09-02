import {
  MODEL_NAMES,
  runtimeHarness,
  type Harness,
  type RuntimeHarness,
} from '../harness-routing/harness.ts';
import {
  configuredModelCandidate,
  modelPairInPool,
  type ModelPairPool,
} from '../config.ts';
import { MODEL_REGISTRY } from '../harness-routing/model-registry.ts';
import { deriveEffortRanges } from '../harness-routing/registry-derivation.ts';

// The live MODEL_REGISTRY's per-model capability scores were retired by the
// modelpolicy campaign (empirical mechanical admission replaced score-based
// steering). This module is the isolated, frozen `create-agent-legacy` path
// — its own copy of the historical capability data below, snapshotted at the
// commit immediately before that retirement, so the legacy acceptance path
// keeps behaving exactly as it always did. Harness/enabled/alias structure
// still comes from the live registry (unaffected by score retirement);
// only the numeric scores are frozen here.
interface LegacyModelCapabilities {
  readonly coding: number;
  readonly planning: number;
  readonly validation: number;
  readonly nonCoding: number;
}
const LEGACY_CAPABILITY_SCORES: Readonly<Record<string, LegacyModelCapabilities>> = {
  [MODEL_NAMES.FABLE]: { coding: 5, planning: 5, validation: 5, nonCoding: 5 },
  [MODEL_NAMES.OPUS]: { coding: 4, planning: 4, validation: 4.2, nonCoding: 4.2 },
  [MODEL_NAMES.SONNET]: { coding: 5.1, planning: 5.1, validation: 5.1, nonCoding: 5.1 },
  [MODEL_NAMES.HAIKU]: { coding: 2, planning: 1, validation: 1, nonCoding: 1 },
  [MODEL_NAMES.GPT_5_6_SOL]: { coding: 5, planning: 5, validation: 5, nonCoding: 5 },
  [MODEL_NAMES.GPT_5_6_TERRA]: { coding: 3.8, planning: 3.8, validation: 3.9, nonCoding: 3.4 },
  [MODEL_NAMES.GPT_5_5]: { coding: 3, planning: 3, validation: 3, nonCoding: 3 },
  [MODEL_NAMES.GPT_5_6_LUNA]: { coding: 5.1, planning: 5.1, validation: 5.1, nonCoding: 5.1 },
  [MODEL_NAMES.GPT_5_4]: { coding: 3, planning: 2, validation: 2, nonCoding: 2.5 },
  [MODEL_NAMES.GPT_5_4_MINI]: { coding: 2, planning: 1.5, validation: 1, nonCoding: 1.5 },
  [MODEL_NAMES.DEEPSEEK_V4_FLASH]: { coding: 1, planning: 1, validation: 1, nonCoding: 1 },
};

const RUNTIME_HARNESSES: readonly RuntimeHarness[] = ['claude', 'codex', 'opencode'];

function legacyScoreTable<Field extends keyof LegacyModelCapabilities>(
  field: Field,
): Record<RuntimeHarness, ReadonlyArray<{ model: string } & Record<Field, number>>> {
  return Object.fromEntries(
    RUNTIME_HARNESSES.map((harness) => [
      harness,
      MODEL_REGISTRY.filter((entryRow) => {
        if (!entryRow.enabled) return false;
        if (entryRow.harness === harness) return true;
        return harness in entryRow.harnessAliases && harness !== entryRow.harness;
      })
        .map((entryRow) => {
          const scores = LEGACY_CAPABILITY_SCORES[entryRow.model];
          return scores === undefined
            ? undefined
            : ({ model: entryRow.model, [field]: scores[field] } as { model: string } & Record<Field, number>);
        })
        .filter((row): row is { model: string } & Record<Field, number> => row !== undefined),
    ]),
  ) as unknown as Record<RuntimeHarness, ReadonlyArray<{ model: string } & Record<Field, number>>>;
}

const CODING_SCORES = legacyScoreTable('coding');
const PLANNING_SCORES = legacyScoreTable('planning');
const VALIDATION_SCORES = legacyScoreTable('validation');
const NON_CODING_SCORES = legacyScoreTable('nonCoding');
const EFFORT_RANGES = deriveEffortRanges(MODEL_REGISTRY);

export const PLANNING_FLOOR = 4;
export const VALIDATION_FLOOR = 4;

export type CapabilityDimension =
  | 'coding'
  | 'planning'
  | 'validation'
  | 'non-coding';

export interface CapabilityRequirement {
  dimension: CapabilityDimension;
  floor: number;
}

export interface CapabilityScore {
  dimension: CapabilityDimension;
  score: number;
}

export interface CapabilityEvidence {
  // Optional so this type stays structurally compatible with the live,
  // score-retired `CapabilityEvidence` ({readonly verdict:"pass"}) — both
  // this isolated legacy path and the shared test fixtures that exercise it
  // can produce or accept either shape. Legacy's own evaluation logic below
  // still always populates both fields.
  requirements?: CapabilityRequirement[];
  final_scores?: CapabilityScore[];
  verdict: 'pass';
}

export type CapabilityRequirementParseResult =
  | { kind: 'requirements'; requirements: CapabilityRequirement[] }
  | { kind: 'refuse'; reason: string };

export type FinalCapabilityVerdict =
  | { kind: 'pass'; evidence: CapabilityEvidence }
  | { kind: 'refuse'; reason: string };

const CAPABILITY_DIMENSIONS: readonly CapabilityDimension[] = [
  'coding',
  'planning',
  'validation',
  'non-coding',
];

const CAPABILITY_FLOOR_MINIMUM = 1;
const CAPABILITY_FLOOR_MAXIMUM = 5;

// Equivalent-model tiers across harnesses. No opencode row exists: deepseek is
// not launchable on claude/codex, and no claude/codex model is valid on
// opencode, so no cross-harness equivalence involving opencode is honest.
const SLICE_MODEL_TIERS: ReadonlyArray<{
  claude: string;
  codex: string;
  opencode?: string;
  // omp has no tier row of its own: no slice equivalence is defined for it
  // yet, so `equivalentModel` simply returns undefined when either side is
  // omp — mechanical typecheck fix only, no new tier data added here.
  omp?: string;
}> = [
  {
    claude: MODEL_NAMES.HAIKU,
    codex: MODEL_NAMES.GPT_5_4_MINI,
  },
  { claude: MODEL_NAMES.SONNET, codex: MODEL_NAMES.GPT_5_4 },
  { claude: MODEL_NAMES.OPUS, codex: MODEL_NAMES.GPT_5_6_SOL },
  { claude: MODEL_NAMES.FABLE, codex: MODEL_NAMES.GPT_5_6_SOL },
];

export function modelPlanningScore(
  harness: Harness,
  model: string,
): number | undefined {
  return PLANNING_SCORES[runtimeHarness(harness)].find((row) => row.model === model)?.planning;
}

export function modelCodingScore(
  harness: Harness,
  model: string,
): number | undefined {
  return CODING_SCORES[runtimeHarness(harness)].find((row) => row.model === model)?.coding;
}

export function modelClearsPlanningFloor(
  harness: Harness,
  model: string,
): boolean {
  const score = modelPlanningScore(harness, model);
  return score !== undefined && score >= PLANNING_FLOOR;
}

export function modelValidationScore(
  harness: Harness,
  model: string,
): number | undefined {
  return VALIDATION_SCORES[runtimeHarness(harness)].find((row) => row.model === model)
    ?.validation;
}

export function modelClearsValidationFloor(
  harness: Harness,
  model: string,
): boolean {
  const score = modelValidationScore(harness, model);
  return score !== undefined && score >= VALIDATION_FLOOR;
}

/** Select the strongest candidate for a capability after harness routing.
 * Model identity is data here; policy is the requested capability metric. */
export function highestCapabilityModel(
  harness: Harness,
  candidates: ModelPairPool,
  dimension: CapabilityDimension,
): { harness: Harness; model: string; score: number } | undefined {
  const scoreFor = (model: string): number | undefined => {
    if (dimension === 'coding') return modelCodingScore(harness, model);
    if (dimension === 'planning') return modelPlanningScore(harness, model);
    if (dimension === 'validation') return modelValidationScore(harness, model);
    return modelNonCodingScore(harness, model);
  };
  return candidates
    .filter((candidate) => candidate.harness === harness)
    .map((candidate, index) => ({
      harness,
      model: candidate.model,
      score: scoreFor(candidate.model),
      index,
    }))
    .filter((candidate): candidate is typeof candidate & { score: number } =>
      candidate.score !== undefined,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
}

export function isModelPairAllowed(
  harness: Harness,
  model: string,
  allowedPairs?: ModelPairPool,
): boolean {
  return (
    allowedPairs === undefined ||
    modelPairInPool(allowedPairs, { harness, model })
  );
}

export function highestValidationModel(
  harness: Harness,
  allowedPairs?: ModelPairPool,
): string | undefined {
  return VALIDATION_SCORES[runtimeHarness(harness)]
    .filter(
      (row) =>
        row.validation >= VALIDATION_FLOOR &&
        isModelPairAllowed(harness, row.model, allowedPairs),
    )
    .sort((left, right) => right.validation - left.validation)[0]?.model;
}

export function modelNonCodingScore(
  harness: Harness,
  model: string,
): number | undefined {
  return NON_CODING_SCORES[runtimeHarness(harness)].find((row) => row.model === model)
    ?.nonCoding;
}

function capabilityDimensionIsKnown(
  dimension: string,
): dimension is CapabilityDimension {
  return CAPABILITY_DIMENSIONS.some((candidate) => candidate === dimension);
}

function normalizedCapabilityFloor(rawFloor: string): number | undefined {
  if (!/^(?:[1-4](?:\.\d+)?|5(?:\.0+)?)$/.test(rawFloor)) {
    return undefined;
  }
  const floor = Number(rawFloor);
  return floor >= CAPABILITY_FLOOR_MINIMUM &&
    floor <= CAPABILITY_FLOOR_MAXIMUM
    ? floor
    : undefined;
}

export function parseCapabilityRequirements(
  expression: string,
): CapabilityRequirementParseResult {
  const clauses = expression.split(',');
  if (clauses.length === 0) {
    return {
      kind: 'refuse',
      reason: `malformed capability requirement "${expression}"`,
    };
  }
  const requirements: CapabilityRequirement[] = [];
  const seen = new Set<CapabilityDimension>();
  for (const clause of clauses) {
    const match = /^([a-z-]+)\s*>=\s*(\S+)$/.exec(clause.trim());
    if (match === null) {
      return {
        kind: 'refuse',
        reason: `malformed capability requirement "${clause.trim() || expression}"`,
      };
    }
    const dimension = match[1]!;
    if (!capabilityDimensionIsKnown(dimension)) {
      return {
        kind: 'refuse',
        reason: `unknown capability dimension "${dimension}"`,
      };
    }
    const floor = normalizedCapabilityFloor(match[2]!);
    if (floor === undefined) {
      return {
        kind: 'refuse',
        reason:
          `malformed capability requirement "${clause.trim()}" — floor must be ` +
          `a number from ${CAPABILITY_FLOOR_MINIMUM} through ${CAPABILITY_FLOOR_MAXIMUM}`,
      };
    }
    if (seen.has(dimension)) {
      return {
        kind: 'refuse',
        reason: `duplicate capability dimension "${dimension}"`,
      };
    }
    seen.add(dimension);
    requirements.push({ dimension, floor });
  }
  requirements.sort(
    (left, right) =>
      CAPABILITY_DIMENSIONS.indexOf(left.dimension) -
      CAPABILITY_DIMENSIONS.indexOf(right.dimension),
  );
  return { kind: 'requirements', requirements };
}

export function modelCapabilityScore(
  harness: Harness,
  model: string,
  dimension: CapabilityDimension,
): number | undefined {
  switch (dimension) {
    case 'coding':
      return modelCodingScore(harness, model);
    case 'planning':
      return modelPlanningScore(harness, model);
    case 'validation':
      return modelValidationScore(harness, model);
    case 'non-coding':
      return modelNonCodingScore(harness, model);
  }
}

export function evaluateFinalCapability(input: {
  requirements: CapabilityRequirement[];
  harness: Harness;
  model: string;
}): FinalCapabilityVerdict {
  const finalScores: CapabilityScore[] = [];
  for (const requirement of input.requirements) {
    const score = modelCapabilityScore(
      input.harness,
      input.model,
      requirement.dimension,
    );
    if (score === undefined) {
      return {
        kind: 'refuse',
        reason:
          `${input.harness}/${input.model} has no authoritative ` +
          `${requirement.dimension} score`,
      };
    }
    if (score < requirement.floor) {
      return {
        kind: 'refuse',
        reason:
          `${input.harness}/${input.model} scores ` +
          `${requirement.dimension} ${score} < ${requirement.floor}`,
      };
    }
    finalScores.push({ dimension: requirement.dimension, score });
  }
  return {
    kind: 'pass',
    evidence: {
      requirements: input.requirements.map((requirement) => ({
        ...requirement,
      })),
      final_scores: finalScores,
      verdict: 'pass',
    },
  };
}

export function modelEffortRange(
  harness: Harness,
  model: string,
): { min: number; max: number } | undefined {
  const row = EFFORT_RANGES[runtimeHarness(harness)].find((row) => row.model === model);
  return row === undefined
    ? undefined
    : { min: row.effortMin, max: row.effortMax };
}

export function equivalentModel(
  model: string,
  from: Harness,
  to: Harness,
  allowedPairs?: ModelPairPool,
): string | undefined {
  if (from === to) {
    return isModelPairAllowed(to, model, allowedPairs) ? model : undefined;
  }
  const tier = SLICE_MODEL_TIERS.find(
    (row) => row[runtimeHarness(from)] === model,
  );
  const tierModel = tier?.[runtimeHarness(to)];
  if (
    tierModel !== undefined &&
    isModelPairAllowed(to, tierModel, allowedPairs)
  ) {
    return tierModel;
  }
  if (allowedPairs === undefined) return undefined;
  const sameModel = configuredModelCandidate({ harness: to, model });
  return sameModel !== undefined && isModelPairAllowed(to, model, allowedPairs)
    ? model
    : undefined;
}

export function thinkingRoleCapabilityGuard(opts: {
  role: string;
  isValidateGate: boolean;
  harness: Harness;
  model: string;
  bypassAlphaGuardrail: boolean;
}): { refuse: boolean; reason?: string; overrideNote?: string } {
  const role = opts.role.trim().toLowerCase();
  const isAlpha = role === 'alpha';
  const isValidationGate = role === 'shadow' && opts.isValidateGate;
  if (!isAlpha && !isValidationGate) return { refuse: false };

  const dimension = isAlpha ? 'planning' : 'validation';
  const floor = isAlpha ? PLANNING_FLOOR : VALIDATION_FLOOR;
  const score = isAlpha
    ? modelPlanningScore(opts.harness, opts.model)
    : modelValidationScore(opts.harness, opts.model);
  const roleDescription = isAlpha ? 'an Alpha' : 'a Shadow 99 validate gate';
  let defaultRefusal: string | undefined;

  if (score === undefined || score < floor) {
    const scoreDescription =
      score === undefined
        ? `has no ${dimension} score in the registry (unproven never clears)`
        : `scores ${dimension} ${score}`;
    defaultRefusal =
      `${roleDescription} requires ${dimension}>=${floor}; ` +
      `${opts.harness}/${opts.model} ${scoreDescription}`;
  }

  if (defaultRefusal === undefined) return { refuse: false };
  if (isAlpha && opts.bypassAlphaGuardrail) {
    return {
      refuse: false,
      overrideNote:
        `--bypass-alpha-guardrail overrode default Alpha policy for this one spawn ` +
        `(requested ${opts.harness}/${opts.model}): ` +
        defaultRefusal,
    };
  }

  const bypassAdvice = isAlpha
    ? '; pass --bypass-alpha-guardrail to override this one Alpha spawn'
    : '';
  return { refuse: true, reason: `${defaultRefusal}${bypassAdvice}` };
}
