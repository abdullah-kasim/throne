import { MODEL_REGISTRY } from './model-registry.ts';
import { OMNI_HARNESS_NAMES, type OmniHarness } from './harness-identity.ts';

// Re-exported for existing consumers (e.g. `omni-routing.ts`) — the names
// themselves live in `harness-identity.ts` now, not here, so this module
// (which reads `MODEL_REGISTRY`, which reads `harness-identity.ts`) never
// closes a load-time cycle back onto that dependency-free module.
export { OMNI_HARNESS_NAMES, type OmniHarness };

// Derived from MODEL_REGISTRY's `omni` field — see the hand-picked-data
// comment beside that field in model-registry.ts for why this is a static
// accessor over literals rather than a computed/fetched lookup.
export const OMNI_MODEL_SLUGS = MODEL_REGISTRY.filter(
  (candidate) => candidate.omni !== undefined,
).map((candidate) => candidate.omni!.executor);

export function isOmniHarness(value: string): value is OmniHarness {
  return Object.values(OMNI_HARNESS_NAMES).includes(value as OmniHarness);
}

export function nativeCodexHarnessRefusal(
  harness: string,
  resuming: boolean,
): string | undefined {
  if (harness !== 'codex') return undefined;
  return resuming
    ? 'its stored native codex recipe is disabled and cannot be relaunched; preserve this registration as migration evidence, reap it explicitly, then create a fresh registration through codexy-all-omni'
    : 'native codex is disabled for fresh agents; use codexy-all-omni without --bypass-harness';
}

export function omniRuntimeHarness(
  harness: OmniHarness,
): 'claude' | 'codex' {
  return harness === OMNI_HARNESS_NAMES.CLAUDEY_ALL_OMNI
    ? 'claude'
    : 'codex';
}

export function omniProviderModel(model: string): string | undefined {
  return MODEL_REGISTRY.find((candidate) => candidate.omni?.executor === model)
    ?.omni?.name;
}

export function isOmniCompatibleModel(model: string): boolean {
  return omniProviderModel(model) !== undefined;
}
