import { HARNESS_NAMES, type RuntimeHarness } from "./harness-identity.ts";
import type { ModelRegistryEntry } from "./model-registry.ts";

const RUNTIME_HARNESSES: readonly RuntimeHarness[] = [
  HARNESS_NAMES.CLAUDE,
  HARNESS_NAMES.CODEX,
  HARNESS_NAMES.OPENCODE,
  HARNESS_NAMES.OMP,
];

/** A model's registry entry is available under a runtime harness `h` when `h`
 * is its own harness (primary) or a key of its `harnessAliases` other than
 * its own harness (secondary — e.g. sol/terra/luna, whose primary harness is
 * `codex`, are also available under `claude`). Enabled entries only. */
export function entryAvailableUnderHarness(
  entry: ModelRegistryEntry,
  harness: RuntimeHarness,
): boolean {
  if (!entry.enabled) return false;
  if (entry.harness === harness) return true;
  return harness in entry.harnessAliases && harness !== entry.harness;
}

/** Per-runtime-harness list of canonical model slugs available on it, derived
 * from each entry's own harness plus its non-primary `harnessAliases` keys. */
export function deriveHarnessAvailability(
  registry: readonly ModelRegistryEntry[],
): Record<RuntimeHarness, readonly string[]> {
  return Object.fromEntries(
    RUNTIME_HARNESSES.map((harness) => [
      harness,
      registry
        .filter((entry) => entryAvailableUnderHarness(entry, harness))
        .map((entry) => entry.model),
    ]),
  ) as unknown as Record<RuntimeHarness, readonly string[]>;
}

/** Compatibility-only fixture helper; score tables are no longer derived for
 * runtime routing. */
export function deriveCapabilityTables(
  _registry: readonly ModelRegistryEntry[],
): {
  coding: Record<RuntimeHarness, readonly { model: string; coding: number }[]>;
} {
  throw new Error("capability tables were retired");
}

/** Per-runtime-harness short-alias → canonical-slug rows sourced from each
 * entry's own `harnessAliases[harness]` spelling (e.g. `codex.sol` →
 * `gpt-5.6-sol`). Only harnesses named in an entry's `harnessAliases` gain a
 * row for it. */
export function deriveCrossHarnessAliasNames(
  registry: readonly ModelRegistryEntry[],
): Partial<Record<RuntimeHarness, Record<string, string>>> {
  const result: Partial<Record<RuntimeHarness, Record<string, string>>> = {};
  for (const entry of registry) {
    for (const [harness, alias] of Object.entries(entry.harnessAliases)) {
      const runtimeHarness = harness as RuntimeHarness;
      (result[runtimeHarness] ??= {})[alias] = entry.model;
    }
  }
  return result;
}

/** Resolve a lowercase alias `key` to its canonical model slug for `harness`,
 * the sole accessor through which callers reach a registry entry's `aliases`
 * or `harnessAliases[harness]` — never destructure/iterate those fields at a
 * call site. Only considers entries available under `harness`. Returns
 * `undefined` when no entry's alias matches. */
export function resolveModelAlias(
  registry: readonly ModelRegistryEntry[],
  harness: RuntimeHarness,
  key: string,
): string | undefined {
  for (const entry of registry) {
    if (!entryAvailableUnderHarness(entry, harness)) continue;
    const harnessAlias = entry.harnessAliases[harness];
    const matchesAlias =
      entry.aliases.some((alias) => alias.toLowerCase() === key) ||
      (harnessAlias !== undefined && harnessAlias.toLowerCase() === key);
    if (matchesAlias) return entry.model;
  }
  return undefined;
}

/** Per-runtime-harness effort-range table, one row per model available under
 * that harness, read straight from the owning entry's `effort` field. */
export function deriveEffortRanges(
  registry: readonly ModelRegistryEntry[],
): Record<
  RuntimeHarness,
  readonly { model: string; effortMin: number; effortMax: number }[]
> {
  return Object.fromEntries(
    RUNTIME_HARNESSES.map((harness) => [
      harness,
      registry
        .filter((entry) => entryAvailableUnderHarness(entry, harness))
        .map((entry) => ({
          model: entry.model,
          effortMin: entry.effort.min,
          effortMax: entry.effort.max,
        })),
    ]),
  ) as unknown as Record<
    RuntimeHarness,
    readonly { model: string; effortMin: number; effortMax: number }[]
  >;
}
