// The Regent liveness classifier — decides whether `resurrectRegent` should
// spawn a fresh Regent, folding herdr's own resolution result together with
// the spawn-marker's "just committed to spawning" signal (see
// `RegentLivenessVerdict.RecentlySpawned`).

import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { AgentResolutionError } from "../herdr/herdr-identity-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { readSpawnMarkerAgeMs } from "./regent-spawn-marker.ts";

/**
 * The canonical unique herdr name the top-level throne harness claims for
 * itself (see `throne-startup.ts`). The heartbeat/watchdog and both Lord
 * controls resolve the Regent by THIS name, never by cwd (every Alpha shares
 * cwd=throne root, so cwd is ambiguous).
 */
export const REGENT_NAME = "Regent";

/**
 * The single live Regent, or `null` when none is running. Resolves by the
 * unique `Regent` name; a ZERO-match is "no Regent" (→ null), while any other
 * herdr failure (incl. the impossible-but-guarded >1 match) propagates — a real
 * error is never mistaken for "absent". This is the shared "is the Regent live"
 * primitive the watchdog and both Lord controls gate their idempotency on.
 */
export async function findLiveRegent(
  deps: { resolveAgent: typeof resolveAgent } = { resolveAgent },
): Promise<HerdrAgent | null> {
  try {
    return await deps.resolveAgent(REGENT_NAME);
  } catch (err) {
    if (err instanceof AgentResolutionError && err.matchCount === 0) {
      return null;
    }
    throw err;
  }
}

/**
 * The pre-spawn liveness verdict `resurrectRegent` acts on. `Ambiguous` is
 * distinct from `Uncertain`: an ambiguous `findLiveRegent` rejection (more
 * than one tab already carries the exact `Regent` label) is POSITIVE evidence
 * a Regent already exists, the opposite of not knowing — so it must not be
 * folded into the same "spawn anyway" branch that genuine infrastructure
 * failures take.
 */
export enum RegentLivenessVerdict {
  Live = "live",
  /** Absent from herdr, but a spawn marker younger than
   * `deps.spawnMarkerWindowMs` says a resurrection just committed to
   * spawning — herdr registration lag, not a genuinely dead court. Resolves
   * exactly like `Live`: do not spawn again. */
  RecentlySpawned = "recently-spawned",
  Absent = "absent",
  Ambiguous = "ambiguous",
  Uncertain = "uncertain",
}

/**
 * `classifyRegentLiveness`'s full result: the verdict `resurrectRegent` acts
 * on, plus the raw marker age (when a marker was read at all) so the caller
 * can log it. `DEFAULT_SPAWN_MARKER_WINDOW_MS` is an unmeasured placeholder
 * (see its own doc comment) — `markerAgeMs` is what lets that placeholder
 * become an evidenced constant later instead of staying a guess forever.
 */
export interface RegentLivenessClassification {
  verdict: RegentLivenessVerdict;
  /** `null` when no marker was read at all (herdr reported Live, or no
   * marker file exists yet). Set whenever a marker WAS found, whether it
   * fell inside the window (`RecentlySpawned`) or past it (`Absent`, but a
   * near-miss worth logging — see `resurrectRegent`). */
  markerAgeMs: number | null;
}

/**
 * The subset of `ResurrectDeps` (defined in `regent-state.service.ts`)
 * `classifyRegentLiveness` actually reads. Declared locally instead of
 * imported so this module stays free of `regent-state.service.ts` — every
 * caller already passes a full `ResurrectDeps` object, which structurally
 * satisfies this narrower shape unchanged.
 */
export interface RegentLivenessDeps {
  findLiveRegent: () => Promise<HerdrAgent | null>;
  regentDir: string;
  spawnMarkerWindowMs: number;
}

/**
 * Classifies `deps.findLiveRegent()`'s outcome into the five-way verdict
 * `resurrectRegent` gates its spawn decision on. A herdr Absent result is
 * only trusted as genuinely `Absent` once the spawn marker (if any) is older
 * than `deps.spawnMarkerWindowMs` — see `RegentLivenessVerdict.RecentlySpawned`.
 */
export async function classifyRegentLiveness(
  deps: RegentLivenessDeps,
): Promise<RegentLivenessClassification> {
  try {
    if ((await deps.findLiveRegent()) !== null) {
      return { verdict: RegentLivenessVerdict.Live, markerAgeMs: null };
    }
    const markerAgeMs = await readSpawnMarkerAgeMs(deps.regentDir);
    if (markerAgeMs !== null && markerAgeMs < deps.spawnMarkerWindowMs) {
      return { verdict: RegentLivenessVerdict.RecentlySpawned, markerAgeMs };
    }
    return { verdict: RegentLivenessVerdict.Absent, markerAgeMs };
  } catch (err) {
    return {
      verdict:
        err instanceof AgentResolutionError && err.matchCount > 1
          ? RegentLivenessVerdict.Ambiguous
          : RegentLivenessVerdict.Uncertain,
      markerAgeMs: null,
    };
  }
}
