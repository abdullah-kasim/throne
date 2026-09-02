import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";

/**
 * The other half of hazard #1 (Regent ruling, 2026-08-14, BCL campaign):
 * `SelfRebuildHostedWorker` already refuses to restart until a build
 * SUCCEEDS -- but compile-success is not runtime-success. A generation can
 * build cleanly and still crash, or never reach `READY=1`, once it is
 * actually running. With `throne-backend.service`'s `Restart=always` and no
 * second builder process left alive to notice, nothing would otherwise ever
 * roll a bad generation back -- the court stays down until a human
 * intervenes, because `throne-backend` is what resurrects a dead Regent.
 *
 * This module is deliberately plain functions with zero decorators and zero
 * NestJS imports, importable two ways that must both keep working:
 *   1. From the compiled app itself (`throne-backend-app.ts`), to record a
 *      generation as known-good once real readiness is reached.
 *   2. From `scripts/throne-backend-rollback-guard.mjs`, run by
 *      `ExecStartPre=` via plain `node` against the LIVE CHECKOUT'S `src/`
 *      (never through `dist`) -- the same trick `build-and-publish-dist.mjs`
 *      already relies on. This is what makes the guard survive a
 *      catastrophically broken `dist`: it never imports anything FROM the
 *      generation it is deciding whether to roll back.
 */

export const GENERATION_READINESS_MARKER_DIR = path.join(RUNTIME_DATA_HOME, "state", "generation-readiness");

export interface GenerationReadinessState {
  /** The last generation that reached this unit's own `READY=1`. Absent until the first-ever successful boot. */
  readonly knownGoodGeneration?: string;
  /**
   * The generation an `ExecStartPre` guard run most recently let through
   * without having proof it was good. Cleared (by simply matching
   * `knownGoodGeneration`) once that generation actually reaches readiness.
   */
  readonly attemptedGeneration?: string;
}

function markerPath(unitName: string, markerDir: string): string {
  return path.join(markerDir, `${unitName}.json`);
}

export function readGenerationReadinessState(
  unitName: string,
  markerDir: string = GENERATION_READINESS_MARKER_DIR,
): GenerationReadinessState {
  try {
    const raw = readFileSync(markerPath(unitName, markerDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<GenerationReadinessState>;
    return {
      ...(typeof parsed.knownGoodGeneration === "string" ? { knownGoodGeneration: parsed.knownGoodGeneration } : {}),
      ...(typeof parsed.attemptedGeneration === "string" ? { attemptedGeneration: parsed.attemptedGeneration } : {}),
    };
  } catch {
    return {}; // missing or corrupt -- no evidence, never an error (first-ever boot looks exactly like this)
  }
}

function writeGenerationReadinessState(
  unitName: string,
  state: GenerationReadinessState,
  markerDir: string,
): void {
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(markerPath(unitName, markerDir), `${JSON.stringify(state)}\n`);
}

/** Called by the guard, before `ExecStart` runs, when it is letting an unconfirmed generation through for the first time. */
export function recordAttemptedGeneration(
  unitName: string,
  generation: string,
  markerDir: string = GENERATION_READINESS_MARKER_DIR,
): void {
  const current = readGenerationReadinessState(unitName, markerDir);
  writeGenerationReadinessState(unitName, { ...current, attemptedGeneration: generation }, markerDir);
}

/**
 * Called by the running app itself, once, right after it notifies systemd
 * `READY=1` -- the one and only proof this module trusts that a generation
 * is genuinely good. Never called from the guard script.
 */
export function recordKnownGoodGeneration(
  unitName: string,
  generation: string,
  markerDir: string = GENERATION_READINESS_MARKER_DIR,
): void {
  writeGenerationReadinessState(unitName, { knownGoodGeneration: generation }, markerDir);
}

export type RollbackDecision =
  // The target IS the known-good generation (the common steady-state case,
  // and also true on a from-scratch box with nothing recorded yet): let it
  // through untouched.
  | { readonly action: "proceed-known-good" }
  // The target is new/unrecorded: first attempt, let it through and remember it.
  | { readonly action: "proceed-first-attempt"; readonly generation: string }
  // The target was already attempted and never confirmed ready: this is a
  // RETRY of a bad generation. Roll `dist` back to `rollbackToGeneration`.
  | { readonly action: "roll-back"; readonly from: string; readonly rollbackToGeneration: string }
  // The target already failed once, but there is no known-good generation to
  // fall back to (e.g. the very first boot ever crashed) -- nothing this
  // module can safely repoint to. Proceed anyway; there is no better option.
  | { readonly action: "proceed-no-fallback"; readonly generation: string };

/**
 * The pure decision at the heart of the guard -- deliberately separated from
 * any filesystem access so it is trivially unit-testable. See the module
 * doc comment for the state machine this implements.
 *
 * TOTALITY: exactly one `if` covers each of the four cases above, in order,
 * over the only two facts a decision can depend on (whether `targetGeneration`
 * equals `knownGoodGeneration`, and whether it equals `attemptedGeneration`)
 * -- there is no fifth combination and no path that falls through without
 * returning. `decideRollbackAction.spec`'s exhaustive-combination test
 * proves this by enumeration rather than trusting the reasoning here.
 *
 * NON-OSCILLATION: the guard script's only two mutating actions are (1)
 * writing `attemptedGeneration` (`proceed-first-attempt`) and (2) repointing
 * `dist` to `rollbackToGeneration`, which this function ALWAYS sets to
 * `state.knownGoodGeneration` verbatim -- the guard never invents, computes,
 * or otherwise varies a rollback target, and never writes
 * `knownGoodGeneration` itself (only `recordKnownGoodGeneration`, called
 * exclusively from the running app after real readiness, ever does). So
 * within any stretch of guard invocations uninterrupted by an app reaching
 * readiness, `knownGoodGeneration` is a constant, `dist` can be repointed to
 * at most that ONE value, and repeated guard runs converge in at most two
 * invocations (first-attempt, then roll-back) and stay fixed after that --
 * there is no pair of generations for `dist` to alternate between.
 * `rollback-guard-convergence.test.ts` proves this against the real script
 * across repeated real invocations, not just this function in isolation.
 */
export function decideRollbackAction(
  targetGeneration: string,
  state: GenerationReadinessState,
): RollbackDecision {
  if (state.knownGoodGeneration === targetGeneration) {
    return { action: "proceed-known-good" };
  }
  if (state.attemptedGeneration !== targetGeneration) {
    return { action: "proceed-first-attempt", generation: targetGeneration };
  }
  if (state.knownGoodGeneration !== undefined) {
    return { action: "roll-back", from: targetGeneration, rollbackToGeneration: state.knownGoodGeneration };
  }
  return { action: "proceed-no-fallback", generation: targetGeneration };
}

/**
 * The exact atomic swap `build-and-publish-dist.mjs`'s `publishStagingAsDist`
 * already uses (temp symlink + `rename(2)` over `dist`) -- duplicated here
 * rather than imported, on purpose: this runs from `ExecStartPre`, which
 * must stay independent of that script's own staging/pruning machinery and
 * of anything living inside a generation directory.
 */
export function atomicallyRepointDist(generationRoot: string, generationName: string): void {
  const distLinkPath = path.join(generationRoot, "dist");
  const temporaryLinkPath = path.join(generationRoot, `${generationName}.rollback-publishing`);
  symlinkSync(generationName, temporaryLinkPath);
  renameSync(temporaryLinkPath, distLinkPath);
}
