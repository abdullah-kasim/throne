import {
  HARNESS_NAMES,
  MODEL_NAMES,
  type Harness,
} from "./harness-identity.ts";

export const MODEL_ROLES = {
  ALPHA: "Alpha",
  SHADOW: "Shadow",
  SHADOW_SLICE_99: "ShadowSlice99",
  STAGER: "Stager",
} as const;
export type ModelRole = (typeof MODEL_ROLES)[keyof typeof MODEL_ROLES];

export interface ModelEffortPolicy {
  readonly min: number;
  readonly max: number;
  readonly ordinary: number;
}

/** Compatibility-only input shape for historical fixtures; live registry
 * entries no longer carry numerical model ratings. */
export interface ModelCapabilities {
  readonly coding: number;
  readonly planning: number;
  readonly validation: number;
  readonly nonCoding: number;
}

export interface ModelOmniAdmission {
  /** Provider-qualified name the omni launcher admits, e.g. "codex/gpt-5.6-sol". */
  readonly name: string;
  /** The throne-portable model spelling this admission resolves to. */
  readonly executor: string;
  readonly default?: boolean;
}

export interface ModelRegistryEntry {
  readonly model: string;
  readonly enabled: boolean;
  readonly harness: Harness;
  readonly harnessAliases: Partial<Record<Harness, string>>;
  /** Harness-independent alternate spellings for this model (e.g. sonnet's
   * entry carries `['sonnet-5', 'claude-sonnet-5']`), distinct from
   * `harnessAliases`'s per-harness short names. */
  readonly aliases: readonly string[];
  readonly roles: readonly ModelRole[];
  readonly effort: ModelEffortPolicy;
  readonly capabilities?: ModelCapabilities;
  readonly omni?: ModelOmniAdmission;
}

const ALL_ROLES: readonly ModelRole[] = [
  MODEL_ROLES.ALPHA,
  MODEL_ROLES.SHADOW,
  MODEL_ROLES.SHADOW_SLICE_99,
  MODEL_ROLES.STAGER,
];
const CODEX = HARNESS_NAMES.CODEX;
const CLAUDE = HARNESS_NAMES.CLAUDE;
const OPENCODE = HARNESS_NAMES.OPENCODE;
const OMP = HARNESS_NAMES.OMP;

function entry(
  model: string,
  harness: Harness,
  effort: ModelEffortPolicy = { min: 1, max: 6, ordinary: 1 },
  options: {
    enabled?: boolean;
    roles?: readonly ModelRole[];
    harnessAliases?: Partial<Record<Harness, string>>;
    omni?: ModelOmniAdmission;
    aliases?: readonly string[];
  } = {},
): ModelRegistryEntry {
  return {
    model,
    enabled: options.enabled ?? true,
    harness,
    harnessAliases: options.harnessAliases ?? {},
    aliases: options.aliases ?? [],
    roles: options.roles ?? ALL_ROLES,
    effort,
    omni: options.omni,
  };
}

// Omni-harness admission (`omni` field, below): an API-driven/automated
// approach to resolving these provider-qualified↔executor aliases (fetch,
// codegen, cached JSON snapshot, startup probe) was tried and proved
// fragile — see the deleted `omni-harness.ts` manifest loader, which
// `readFileSync`'d this data at import via a three-deep parent-path guess.
// These three values are therefore deliberately hand-picked. Adding a new
// omni harness alias requires an agent or human to call the provider API
// manually and DECIDE which alias/executor spelling to use — never restore
// an automated resolver here.
/** The single authoritative model identity and admission registry. */
export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = [
  // EVERY MODEL'S PRIMARY HARNESS IS ITS NATIVE ONE, AND MUST STAY THAT WAY.
  // The Lord, 2026-08-29: "lets switch all harnesses back to native. and make
  // sure we dont change the native harnesses to a non native one."
  //
  // Anthropic models are `claude`; ChatGPT models are `codex`. `create-agent`
  // infers the harness from THIS FIELD ALONE (`request.ts`:
  // `harness = entry.harness`), so this column is the court's default route
  // for every spawn that does not name a harness explicitly.
  //
  // DO NOT REPOINT A PRIMARY AT A NON-NATIVE HARNESS. It was done once, on
  // 2026-08-27, to make `--model fable` reach omp, and the blast radius was
  // not obvious from the diff: `PRIMARY_CLAUDE_MODELS` in `harness.ts` derived
  // itself from `harness === CLAUDE`, so moving the primaries EMPTIED it,
  // which made `isGptModel("fable")` return true, which swallowed every
  // Anthropic pair into `LEGACY_RESUME_ONLY_MODEL_PAIRS`, which removed them
  // from `CONFIGURED_MODEL_PAIRS`, which killed config load for any preset
  // naming one — every throne command dead at startup. That derivation has
  // since been made harness-agnostic, but the lesson stands: this field is
  // read by more than the spawn path, and a one-word change here reaches
  // places the diff does not show.
  //
  // A non-native harness is selected by the PRESET (`config.user.ts`
  // `activeHarness`, or a pair naming it), never by rewriting these rows.
  // That is the difference between a reversible court-wide decision and a
  // permanent change to what every model IS.
  // `no-non-native-primary-harness.test.ts` enforces this; if it fails, the
  // fix is to revert the row, not to relax the test.
  entry(MODEL_NAMES.FABLE, CLAUDE, undefined, {
    aliases: ["fable-5", "claude-fable-5"],
    harnessAliases: { [OMP]: "claude-fable-5" },
  }),
  entry(MODEL_NAMES.OPUS, CLAUDE, undefined, {
    aliases: ["opus-4.8", "opus4.8", "claude-opus-4-8", "claude-opus-5"],
    harnessAliases: { [OMP]: "claude-opus-5" },
  }),
  entry(MODEL_NAMES.SONNET, CLAUDE, undefined, {
    aliases: ["sonnet-5", "claude-sonnet-5"],
    harnessAliases: { [OMP]: "claude-sonnet-5" },
  }),
  entry(MODEL_NAMES.HAIKU, CLAUDE, undefined, {
    aliases: ["haiku-4.5", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    harnessAliases: { [OMP]: "claude-haiku-4-5" },
  }),
  entry(MODEL_NAMES.GPT_5_6_SOL, CODEX, undefined, {
    harnessAliases: { [CLAUDE]: "sol", [CODEX]: "sol", [OMP]: "gpt-5.6-sol" },
    omni: { name: "codex/gpt-5.6-sol", executor: "gpt-5.6-sol", default: true },
  }),
  entry(MODEL_NAMES.GPT_5_6_TERRA, CODEX, undefined, {
    harnessAliases: {
      [CLAUDE]: "terra",
      [CODEX]: "terra",
      [OMP]: "gpt-5.6-terra",
    },
    omni: { name: "codex/gpt-5.6-terra", executor: "gpt-5.6-terra" },
  }),
  entry(MODEL_NAMES.GPT_5_5, CODEX, { min: 1, max: 4, ordinary: 1 }, {
    harnessAliases: { [OMP]: "gpt-5.5" },
  }),
  entry(
    MODEL_NAMES.GPT_5_6_LUNA,
    CODEX,
    { min: 1, max: 1, ordinary: 1 },
    {
      harnessAliases: { [CLAUDE]: "luna", [CODEX]: "luna", [OMP]: "gpt-5.6-luna" },
    },
  ),
  entry(MODEL_NAMES.GPT_5_4, CODEX, { min: 1, max: 4, ordinary: 1 }, {
    harnessAliases: { [OMP]: "gpt-5.4" },
  }),
  entry(MODEL_NAMES.GPT_5_4_MINI, CODEX, { min: 1, max: 4, ordinary: 1 }, {
    harnessAliases: { [OMP]: "gpt-5.4-mini" },
  }),
  entry(
    MODEL_NAMES.DEEPSEEK_V4_FLASH,
    OPENCODE,
    { min: 1, max: 1, ordinary: 1 },
    {
      enabled: false,
      roles: [],
      harnessAliases: { [OPENCODE]: "deepseek" },
      omni: {
        name: "opencode-go/deepseek-v4-flash",
        executor: "opencode-go/deepseek-v4-flash",
      },
    },
  ),
];

// The single-default invariant: replaces the deleted manifest loader's
// `parseManifest` throw, which enforced exactly one `default: true` row.
// Enforced as code at module load, not documentation, so a bad hand-edit
// fails immediately rather than silently admitting two defaults.
const OMNI_DEFAULT_COUNT = MODEL_REGISTRY.filter(
  (candidate) => candidate.omni?.default === true,
).length;
if (OMNI_DEFAULT_COUNT !== 1) {
  throw new Error(
    `MODEL_REGISTRY must have exactly one entry with omni.default === true, found ${OMNI_DEFAULT_COUNT}`,
  );
}

const HARNESS_VALUES = new Set(Object.values(HARNESS_NAMES));
const ROLE_VALUES = new Set(Object.values(MODEL_ROLES));

export function parseHarness(value: unknown): Harness {
  if (typeof value === "string" && HARNESS_VALUES.has(value as Harness))
    return value as Harness;
  throw new Error(`unknown harness "${String(value)}"`);
}

export function parseModelRole(value: unknown): ModelRole {
  if (typeof value === "string" && ROLE_VALUES.has(value as ModelRole))
    return value as ModelRole;
  throw new Error(`unknown model role "${String(value)}"`);
}

export function parseModelRegistryEntry(value: unknown): ModelRegistryEntry {
  if (!value || typeof value !== "object")
    throw new Error("model registry entry must be an object");
  const candidate = value as Partial<ModelRegistryEntry>;
  const harness = parseHarness(candidate.harness);
  if (
    typeof candidate.model !== "string" ||
    typeof candidate.enabled !== "boolean"
  ) {
    throw new Error("model registry entry requires model and enabled");
  }
  if (!Array.isArray(candidate.roles))
    throw new Error("model registry entry roles must be an array");
  const roles = candidate.roles.map(parseModelRole);
  if (
    !candidate.harnessAliases ||
    typeof candidate.harnessAliases !== "object"
  ) {
    throw new Error("model registry entry harnessAliases must be an object");
  }
  for (const [aliasHarness, alias] of Object.entries(
    candidate.harnessAliases,
  )) {
    parseHarness(aliasHarness);
    if (typeof alias !== "string" || alias.length === 0)
      throw new Error("harness aliases must be non-empty strings");
  }
  const aliases = candidate.aliases ?? [];
  if (!Array.isArray(aliases))
    throw new Error("model registry entry aliases must be an array");
  for (const alias of aliases) {
    if (typeof alias !== "string" || alias.length === 0)
      throw new Error("aliases must be non-empty strings");
  }
  return {
    ...candidate,
    harness,
    roles,
    harnessAliases: candidate.harnessAliases,
    aliases,
  } as ModelRegistryEntry;
}

export function registryEntry(model: string): ModelRegistryEntry | undefined {
  return MODEL_REGISTRY.find((candidate) => candidate.model === model);
}

/** Resolve a caller model alias to its canonical registry entry. */
export function resolveRegistryModel(model: string): ModelRegistryEntry {
  const key = model.trim().toLowerCase();
  const resolved = MODEL_REGISTRY.find(
    (candidate) =>
      candidate.model === key ||
      Object.values(candidate.harnessAliases).some(
        (alias) => alias.toLowerCase() === key,
      ),
  );
  if (resolved !== undefined && resolved.enabled) return resolved;
  if (resolved !== undefined) {
    throw new Error(
      `model "${model}" is disabled and historical-only; it cannot be used for a fresh spawn`,
    );
  }
  throw new Error(
    `unknown model "${model}" — valid registry models: ${MODEL_REGISTRY.filter(
      (candidate) => candidate.enabled,
    )
      .map((candidate) => candidate.model)
      .join(", ")}`,
  );
}
