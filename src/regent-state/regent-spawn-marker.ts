import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS,
  OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS,
} from "../herdr/herdr-errors.ts";

/**
 * A durable marker recorded the instant a resurrection commits to spawning
 * (written just before `startAgent`, while still holding the resurrection
 * lock) — see `writeSpawnMarker`. It closes the gap the lock alone cannot:
 * the lock only arbitrates callers whose check-then-spawn windows OVERLAP.
 * A second, fully independent attempt that arrives strictly AFTER the first
 * has released the lock finds no lock to contend — but if herdr has not yet
 * caught up, `findLiveRegent` still reports Absent, and an unguarded second
 * attempt would spawn a genuine duplicate. The marker is the signal that
 * survives past the lock's release: `classifyRegentLiveness` treats a marker
 * younger than this window as "recently spawned, not yet visible" — the same
 * "do not spawn" outcome as a confirmed-live Regent — instead of Absent.
 */
export const SPAWN_MARKER_BASENAME = "spawn-marker";
/**
 * `deliverOpeningPrompt` (via `waitForAgentRegistration`) already polls
 * herdr up to this long, on every successful resurrection, before it will
 * even attempt delivery — this is the closest thing in the repo to a
 * MEASURED bound on herdr registration latency: it is the budget the
 * opening-prompt path itself already trusts and lives or dies by, not a
 * fresh guess. On the success path this means herdr is normally already
 * visible again by the time `resurrectRegent` releases the lock, so the
 * marker mostly matters when this budget was exceeded (the marker's window
 * below is set with headroom above it, not equal to it, for exactly that
 * reason).
 */
export const MAX_HERDR_REGISTRATION_WAIT_MS =
  (OPENING_PROMPT_NAME_REGISTRATION_ATTEMPTS - 1) *
  OPENING_PROMPT_NAME_REGISTRATION_POLL_MILLISECONDS;
/**
 * How long a spawn marker is trusted over a herdr Absent result. Grounded in
 * `MAX_HERDR_REGISTRATION_WAIT_MS` — the existing, already-tuned signal for
 * how long herdr registration is allowed to take before `deliverOpeningPrompt`
 * itself gives up — with headroom for the case that budget was exceeded
 * (the reason the marker is still needed at all; see its doc comment above).
 * Not a fresh unmeasured number: it is a multiple of one the repo already
 * trusts elsewhere. It must still stay small relative to
 * `RESURRECT_LOCK_STALE_MS`: the marker's whole job is to bridge a brief
 * registration lag, not to become a second, longer-lived reason to withhold
 * resurrection from a genuinely dead court. Injectable via
 * `ResurrectDeps.spawnMarkerWindowMs` so tests can exercise both "inside the
 * window" and "past the window, resurrection is never wedged" without
 * waiting on the real duration.
 */
export const DEFAULT_SPAWN_MARKER_WINDOW_MS =
  MAX_HERDR_REGISTRATION_WAIT_MS * 3;

/**
 * Record that a resurrection has just committed to spawning — durable, in
 * `dir` (mirrors the `desired-state`/`harness`/lock marker-file pattern
 * above). Called just before `startAgent`, while the resurrection lock is
 * still held, so the marker is on disk before any concurrent process could
 * possibly observe the lock's release.
 */
export async function writeSpawnMarker(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, SPAWN_MARKER_BASENAME),
    `${Date.now()}\n`,
    "utf8",
  );
}

/**
 * Age of the spawn marker in `dir`, in milliseconds, or `null` if there is
 * none (never spawned, or long since irrelevant). Uses the file's mtime, not
 * its content, the same identity-light approach the lock's staleness check
 * uses — the marker only ever needs to answer "how long ago", never "who".
 */
export async function readSpawnMarkerAgeMs(
  dir: string,
): Promise<number | null> {
  try {
    const info = await stat(path.join(dir, SPAWN_MARKER_BASENAME));
    // Clamped to >= 0 and rounded: filesystem mtime resolution can round UP
    // past `Date.now()`'s own sample an instant later, which would otherwise
    // read as a negative age (and, at a zero-width window, incorrectly
    // satisfy `age < window`). A marker can never be observed as "from the
    // future" for this check's purposes.
    return Math.max(0, Math.round(Date.now() - info.mtimeMs));
  } catch {
    return null;
  }
}
