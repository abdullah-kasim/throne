// Machine-local steering override: which plan preset and target effort a
// fresh spawn steers toward. Two layers, mirroring the persona config
// precedent in `application-config.service.ts`: the committed default below
// is what a fresh clone runs with, and an OPTIONAL, gitignored
// `<live throne root>/config.user.ts`'s `steering` section supplies a partial
// override merged over it, so machine-local steering never lands in git.
// The parse+validate of the whole file (including the loud refusal when a
// retired `<live throne root>/src/config.user.ts` is still present) is owned
// by `user-config-loader.ts`; this module only validates and merges its own
// `steering` section.
//
// STEERS OVER `MODEL_REGISTRY` (`harness-routing/model-registry.ts`) — this
// module declares no model, harness, capability, or effort-range fact of its
// own; it only selects which registered plan preset is active and what
// effort target every fresh spawn is clamped toward.
//
// Resolved from the LIVE THRONE ROOT, not the running checkout: a worktree
// executing this module must observe the same steering as the live root.
// Root discovery itself (production anchored to the running module's own
// on-disk location, tests/fixtures deriving it via a git primitive,
// `THRONE_LIVE_ROOT` short-circuiting both) is owned by
// `throne-root-resolution.ts`, shared with `user-config-loader.ts`'s own
// default-path resolution — this module only calls it.
//
// An ABSENT override is silent and fine — it resolves to `DEFAULT_STEERING_CONFIG`.
// A PRESENT-but-invalid override, or a failure to resolve the live throne
// root, throws: silent divergence between the operator's configured steering
// and what the fleet actually runs is a worse failure than a startup error.
//
// Every value is reached through `activePlanPresetName()`/`activeTargetEffort()`
// — no consumer reads a plain exported constant — so a later literal-to-function
// field (e.g. a resolver callback) is a one-file change to this module's
// `SteeringConfigOverride` type and its accessors, never a change at any call site.

import {
  describeValue,
  isPlainObject,
} from './shared-policy/config-value-shape.ts';
import { resolveLiveThroneRoot } from './throne-root-resolution.ts';
import {
  STEERING_SECTION_FIELDS,
  loadUserConfigFile,
  userConfigPath,
} from './user-config-loader.ts';

export const PLAN_PRESET_NAMES = [
  'GptOnly',
  'AnthropicOnly',
  'Optimized',
  'Whichever',
  'UnifiedRouting',
] as const;
/** The names shipped in `src/config.ts`'s committed preset table. */
export type BuiltinPlanPresetName = (typeof PLAN_PRESET_NAMES)[number];

/** A preset name: one of the committed built-ins, or the name of a
 *  `customPlanPresets` entry the operator defined in `config.user.ts`.
 *  The closed-union compile-time guarantee moved to runtime validation
 *  (`loadSteeringConfig` refuses a name that resolves to neither). */
export type PlanPresetName = string;

/** One harness/model pair literal in a custom preset pool. Validated here
 *  only structurally; `src/config.ts` checks each pair against the canonical
 *  configured-pair table when it materializes the preset. */
export interface CustomPlanPresetPair {
  readonly harness: string;
  readonly model: string;
}

/** The three campaign-role pools a custom preset defines. Stager is
 *  deliberately NOT definable here — a preset names campaign roles only.
 *  The Stager pair is set by the top-level `stagerPool` field instead, so
 *  swapping the campaign preset can never move the Stager by accident. */
export interface CustomPlanPresetPools {
  readonly alpha: readonly CustomPlanPresetPair[];
  readonly shadow: readonly CustomPlanPresetPair[];
  readonly shadowSlice99: readonly CustomPlanPresetPair[];
}

export type MessageQueueTransport = 'sqlite';

export interface SteeringConfig {
  readonly activePlanPresetName: PlanPresetName;
  readonly activeTargetEffort: number;
  /**
   * Run every campaign role on THIS harness, whatever harness the active
   * preset's pairs happen to name. Absent means "use each pair as written".
   *
   * WHY THIS IS ITS OWN FIELD. A role pool pair carries a harness AND a
   * model, so changing harness meant rewriting every pool — and changing
   * MODEL meant rewriting the harness alongside it, which is how a preset
   * switch silently changed cost on 2026-08-26: widening a pool to move
   * harness also removed the single-entry permission wall that had been
   * pinning the model. The two decisions are independent and now say so.
   *
   * "I want terra for alpha, shadow and shadowSlice99" is a preset. "Run it
   * all on omp" is this. Neither should require editing the other.
   *
   * The Stager is deliberately NOT affected: it stays pinned by
   * `rolePools()` in `src/config.ts` by standing order, independent of every
   * preset, and a harness override is no more entitled to move it than a
   * preset is.
   */
  readonly activeHarness?: string;
  /**
   * Explicit queue transport marker. When present, it can only identify the
   * SQLite delivery path.
   */
  readonly messageQueueTransport?: MessageQueueTransport;
  readonly customPlanPresets: Readonly<Record<string, CustomPlanPresetPools>>;
  /**
   * The Stager's own pair pool. Absent means the committed pin in
   * `src/config.ts` (claude/opus) stands.
   *
   * WHY ITS OWN FIELD, and not a preset pool or `activeHarness`. The Stager
   * is not a campaign role: it is the Lord's standing point of contact, and
   * a campaign-wide preset or harness switch must never move it as a side
   * effect — that is the standing order the pin exists to enforce. But the
   * order pins WHAT the Stager runs on, not that it is unchangeable: when
   * the Lord moves the court onto a new harness he must be able to move the
   * Stager too, deliberately, in one place, without editing `src/config.ts`.
   * This field is that place. It is read by NOTHING except the Stager pool.
   *
   * 2026-08-26: set to omp/opus on the Lord's direct order — the whole court
   * had moved to omp while the Stager alone was still spawning on the native
   * claude harness, which is exactly the divergence this field makes visible.
   */
  readonly stagerPool?: readonly CustomPlanPresetPair[];
  /** The durable operator disable setting for the token-balance load
   *  balancer (see `src/token-balance/`), independent of that feature's own
   *  ship-dark env-var kill switch — either OFF is independently sufficient
   *  to fully de-gate. Absent-means-disabled: a fresh clone with no override
   *  runs balancer-off, matching every other steering field's "committed
   *  default is the conservative one" convention. */
  readonly tokenBalanceEnabled: boolean;
}

/** The shape a `config.user.ts` default export may take: every field
 *  optional, literal values only — no function-valued field. */
export interface SteeringConfigOverride {
  readonly activePlanPresetName?: PlanPresetName;
  readonly activeTargetEffort?: number;
  /** See `SteeringConfig.activeHarness`. */
  readonly activeHarness?: string;
  /** See `SteeringConfig.messageQueueTransport`. */
  readonly messageQueueTransport?: MessageQueueTransport;
  readonly customPlanPresets?: Readonly<Record<string, CustomPlanPresetPools>>;
  /** See `SteeringConfig.stagerPool`. */
  readonly stagerPool?: readonly CustomPlanPresetPair[];
  readonly tokenBalanceEnabled?: boolean;
}

/** The committed, deliberately conservative default: the values
 *  `src/config.ts` hand-edited as literals before this module existed. */
export const DEFAULT_STEERING_CONFIG: SteeringConfig = {
  activePlanPresetName: 'UnifiedRouting',
  activeTargetEffort: 1,
  customPlanPresets: {},
  tokenBalanceEnabled: false,
};

/** Delegates to the merged file's path (`user-config-loader.ts`) — steering no
 *  longer owns a path of its own, it reads a section of the shared file. */
export function steeringUserConfigPath(liveThroneRoot: string): string {
  return userConfigPath(liveThroneRoot);
}

/** The steering section's accepted keys: `user-config-loader.ts`'s list,
 *  imported rather than restated, so the outer gate and this validator can
 *  never disagree about what a valid steering key is. */
const STEERING_KNOWN_FIELDS = STEERING_SECTION_FIELDS;

const CUSTOM_POOL_FIELDS = ['alpha', 'shadow', 'shadowSlice99'] as const;

function validateCustomPresetPool(
  value: unknown,
  sourcePath: string,
  fieldPath: string,
): readonly CustomPlanPresetPair[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidSteeringConfig(
      sourcePath,
      fieldPath,
      `must be a non-empty array of { harness, model } pairs (got ${describeValue(value)})`,
    );
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw invalidSteeringConfig(
        sourcePath,
        `${fieldPath}[${index}]`,
        `must be a plain { harness, model } object (got ${describeValue(entry)})`,
      );
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'harness' && key !== 'model') {
        throw invalidSteeringConfig(
          sourcePath,
          `${fieldPath}[${index}].${key}`,
          'is not a known field (expected only: harness, model)',
        );
      }
    }
    const { harness, model } = entry;
    if (typeof harness !== 'string' || harness.length === 0) {
      throw invalidSteeringConfig(
        sourcePath,
        `${fieldPath}[${index}].harness`,
        `must be a non-empty string (got ${describeValue(harness)})`,
      );
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw invalidSteeringConfig(
        sourcePath,
        `${fieldPath}[${index}].model`,
        `must be a non-empty string (got ${describeValue(model)})`,
      );
    }
    return { harness, model };
  });
}

function validateCustomPlanPresets(
  value: unknown,
  sourcePath: string,
): Readonly<Record<string, CustomPlanPresetPools>> {
  if (!isPlainObject(value)) {
    throw invalidSteeringConfig(
      sourcePath,
      'customPlanPresets',
      `must be a plain object mapping preset names to pools (got ${describeValue(value)})`,
    );
  }
  const presets: Record<string, CustomPlanPresetPools> = {};
  for (const [name, pools] of Object.entries(value)) {
    if (name.trim().length === 0) {
      throw invalidSteeringConfig(
        sourcePath,
        'customPlanPresets',
        'must not contain an empty preset name',
      );
    }
    if ((PLAN_PRESET_NAMES as readonly string[]).includes(name)) {
      throw invalidSteeringConfig(
        sourcePath,
        `customPlanPresets.${name}`,
        `must not shadow a built-in preset name (built-ins: ${PLAN_PRESET_NAMES.join(', ')})`,
      );
    }
    if (!isPlainObject(pools)) {
      throw invalidSteeringConfig(
        sourcePath,
        `customPlanPresets.${name}`,
        `must be a plain object with alpha/shadow/shadowSlice99 pools (got ${describeValue(pools)})`,
      );
    }
    for (const key of Object.keys(pools)) {
      if (!CUSTOM_POOL_FIELDS.includes(key as (typeof CUSTOM_POOL_FIELDS)[number])) {
        throw invalidSteeringConfig(
          sourcePath,
          `customPlanPresets.${name}.${key}`,
          `is not a known field (expected one of: ${CUSTOM_POOL_FIELDS.join(', ')})`,
        );
      }
    }
    presets[name] = {
      alpha: validateCustomPresetPool(
        pools.alpha,
        sourcePath,
        `customPlanPresets.${name}.alpha`,
      ),
      shadow: validateCustomPresetPool(
        pools.shadow,
        sourcePath,
        `customPlanPresets.${name}.shadow`,
      ),
      shadowSlice99: validateCustomPresetPool(
        pools.shadowSlice99,
        sourcePath,
        `customPlanPresets.${name}.shadowSlice99`,
      ),
    };
  }
  return presets;
}

function invalidSteeringConfig(
  sourcePath: string,
  field: string,
  expectation: string,
): Error {
  return new Error(
    `Invalid steering config in "${sourcePath}": \`${field}\` ${expectation}.`,
  );
}

/**
 * Validates `config.user.ts`'s `steering` section (already extracted and
 * type-checked as a plain object by `user-config-loader.ts`) and returns it
 * as a partial override. Throws on anything it cannot accept; `sourcePath` is
 * the file named in every error message. Mirrors `validatePersonaOverride`'s
 * shape: unknown keys rejected, each known field typed-checked, every
 * rejection names the file, the field, and the expectation.
 */
export function validateSteeringOverride(
  value: unknown,
  sourcePath: string,
): SteeringConfigOverride {
  if (!isPlainObject(value)) {
    throw invalidSteeringConfig(
      sourcePath,
      'steering',
      `must be a plain object (got ${describeValue(value)})`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!STEERING_KNOWN_FIELDS.includes(key as (typeof STEERING_KNOWN_FIELDS)[number])) {
      throw invalidSteeringConfig(
        sourcePath,
        key,
        `is not a known field (expected one of: ${STEERING_KNOWN_FIELDS.join(', ')})`,
      );
    }
  }
  const override: { -readonly [K in keyof SteeringConfigOverride]: SteeringConfigOverride[K] } =
    {};
  if ('activeHarness' in value) {
    const harness = value.activeHarness;
    // Structural only. Whether this harness can actually run the active
    // preset's models is checked in `src/config.ts`, where the configured
    // pair table is in scope — and it fails closed there rather than
    // silently falling back to each pair's original harness.
    if (typeof harness !== 'string' || harness.trim().length === 0) {
      throw invalidSteeringConfig(
        sourcePath,
        'activeHarness',
        `must be a non-empty harness name (got ${describeValue(harness)})`,
      );
    }
    override.activeHarness = harness.trim();
  }
  if ('messageQueueTransport' in value) {
    const transport = value.messageQueueTransport;
    if (transport !== 'sqlite') {
      throw invalidSteeringConfig(
        sourcePath,
        'messageQueueTransport',
        `must be "sqlite" (got ${describeValue(transport)})`,
      );
    }
    override.messageQueueTransport = transport;
  }
  if ('activePlanPresetName' in value) {
    const presetName = value.activePlanPresetName;
    // Membership (built-in or defined custom preset) is checked post-merge in
    // `loadSteeringConfig`, where both fields are known together.
    if (typeof presetName !== 'string' || presetName.trim().length === 0) {
      throw invalidSteeringConfig(
        sourcePath,
        'activePlanPresetName',
        `must be a non-empty string naming a built-in (${PLAN_PRESET_NAMES.join(', ')}) or a customPlanPresets entry (got ${describeValue(presetName)})`,
      );
    }
    override.activePlanPresetName = presetName;
  }
  if ('customPlanPresets' in value) {
    override.customPlanPresets = validateCustomPlanPresets(
      value.customPlanPresets,
      sourcePath,
    );
  }
  if ('stagerPool' in value) {
    // Same structural validation as a preset pool; `src/config.ts` checks
    // each pair against the canonical configured-pair table, fail-closed.
    override.stagerPool = validateCustomPresetPool(
      value.stagerPool,
      sourcePath,
      'stagerPool',
    );
  }
  if ('activeTargetEffort' in value) {
    const targetEffort = value.activeTargetEffort;
    if (typeof targetEffort !== 'number' || !Number.isInteger(targetEffort) || targetEffort < 1) {
      throw invalidSteeringConfig(
        sourcePath,
        'activeTargetEffort',
        `must be an integer >= 1 (got ${describeValue(targetEffort)})`,
      );
    }
    override.activeTargetEffort = targetEffort;
  }
  if ('tokenBalanceEnabled' in value) {
    const tokenBalanceEnabled = value.tokenBalanceEnabled;
    if (typeof tokenBalanceEnabled !== 'boolean') {
      throw invalidSteeringConfig(
        sourcePath,
        'tokenBalanceEnabled',
        `must be a boolean (got ${describeValue(tokenBalanceEnabled)})`,
      );
    }
    override.tokenBalanceEnabled = tokenBalanceEnabled;
  }
  return override;
}

function mergeSteeringConfig(
  base: SteeringConfig,
  override: SteeringConfigOverride,
): SteeringConfig {
  return {
    activePlanPresetName:
      override.activePlanPresetName ?? base.activePlanPresetName,
    activeTargetEffort: override.activeTargetEffort ?? base.activeTargetEffort,
    // Spread-free merge on purpose: an explicitly-listed field cannot be
    // silently dropped by a later refactor the way an omitted spread key can.
    // This one WAS dropped on its first attempt — accepted by both validators
    // and then quietly lost here, so the pools kept their original harness
    // while the config said otherwise.
    ...(override.activeHarness ?? base.activeHarness) === undefined
      ? {}
      : { activeHarness: override.activeHarness ?? base.activeHarness },
    ...(override.messageQueueTransport ?? base.messageQueueTransport) === undefined
      ? {}
      : {
          messageQueueTransport:
            override.messageQueueTransport ?? base.messageQueueTransport,
        },
    customPlanPresets: override.customPlanPresets ?? base.customPlanPresets,
    // Explicitly listed for the same reason as `activeHarness` above: an
    // optional field lost in a spread merges silently and wrongly.
    ...(override.stagerPool ?? base.stagerPool) === undefined
      ? {}
      : { stagerPool: override.stagerPool ?? base.stagerPool },
    tokenBalanceEnabled:
      override.tokenBalanceEnabled ?? base.tokenBalanceEnabled,
  };
}

/**
 * Resolves the effective steering config: the committed default with the
 * merged `config.user.ts`'s `steering` section merged over it. An absent
 * merged file yields the default; an invalid `steering` section, an
 * unreadable/unimportable file, or a still-present legacy `src/config.user.ts`
 * throws — the last of those via `loadUserConfigFile`, which checks for the
 * legacy file BEFORE reading anything from the merged one.
 */
export async function loadSteeringConfig(
  configPath?: string,
): Promise<SteeringConfig> {
  const resolvedPath =
    configPath ?? steeringUserConfigPath(await resolveLiveThroneRoot());
  const userConfigFile = await loadUserConfigFile(resolvedPath);
  if (userConfigFile === undefined) return DEFAULT_STEERING_CONFIG;
  const merged = mergeSteeringConfig(
    DEFAULT_STEERING_CONFIG,
    validateSteeringOverride(userConfigFile.steering, resolvedPath),
  );
  // Cross-field membership check: the active name must resolve to a built-in
  // or to a custom preset defined in the same file. Checked post-merge so a
  // custom name is admitted only when its definition is actually present.
  if (
    !(PLAN_PRESET_NAMES as readonly string[]).includes(
      merged.activePlanPresetName,
    ) &&
    !(merged.activePlanPresetName in merged.customPlanPresets)
  ) {
    throw invalidSteeringConfig(
      resolvedPath,
      'activePlanPresetName',
      `must name a built-in preset (${PLAN_PRESET_NAMES.join(', ')}) or a defined customPlanPresets entry (got "${merged.activePlanPresetName}"; defined customs: ${Object.keys(merged.customPlanPresets).join(', ') || 'none'})`,
    );
  }
  return merged;
}

/** The effective config, resolved once per process. */
const RESOLVED_STEERING_CONFIG: SteeringConfig = await loadSteeringConfig();

/** The active plan preset name: the sole way any consumer reads this value. */
export function activePlanPresetName(): PlanPresetName {
  return RESOLVED_STEERING_CONFIG.activePlanPresetName;
}

/** The harness every campaign role is steered onto, or undefined to use each
 *  pool pair's own harness: the sole way any consumer reads this value. */
export function activeHarness(): string | undefined {
  return RESOLVED_STEERING_CONFIG.activeHarness;
}

/** Explicit operator queue transport marker for the SQLite delivery path. */
export function activeMessageQueueTransport(): MessageQueueTransport | undefined {
  return RESOLVED_STEERING_CONFIG.messageQueueTransport;
}

/** The target effort every fresh spawn is steered to, before the per-model
 *  clamp: the sole way any consumer reads this value. */
export function activeTargetEffort(): number {
  return RESOLVED_STEERING_CONFIG.activeTargetEffort;
}

/** The operator-defined custom presets from `config.user.ts` (empty when
 *  none are defined): the sole way any consumer reads them. `src/config.ts`
 *  materializes these into real presets, validating every pair against the
 *  canonical configured-pair table. */
export function activeCustomPlanPresets(): Readonly<
  Record<string, CustomPlanPresetPools>
> {
  return RESOLVED_STEERING_CONFIG.customPlanPresets;
}

/** The operator's Stager pair pool, or undefined to keep the committed pin
 *  in `src/config.ts`: the sole way any consumer reads this value. */
export function activeStagerPool():
  | readonly CustomPlanPresetPair[]
  | undefined {
  return RESOLVED_STEERING_CONFIG.stagerPool;
}

/** Whether the token-balance load balancer's durable operator disable
 *  setting is ON — the sole way any consumer reads this value. Independent
 *  of `isTokenBalanceKillSwitchOn` (the env-var ship-dark switch); a
 *  consumer must check both, since either being "off" fully de-gates. */
export function isTokenBalanceEnabled(): boolean {
  return RESOLVED_STEERING_CONFIG.tokenBalanceEnabled;
}
