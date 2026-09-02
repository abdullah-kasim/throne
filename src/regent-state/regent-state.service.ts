import { Injectable } from "@nestjs/common";
// The Regent's durable desired-state + resurrection primitives — the machinery
// that lets the court survive the Regent's OWN death.
//
// You CANNOT detect the manner of a Regent's death: a crash/`kill -9`/reboot
// leaves no note, and an exit hook never fires on a hard kill. So intent is
// recorded DECLARATIVELY, exactly like systemd enable/disable:
//   - desired-state `running`   (default) → "there should always be a Regent";
//                                            resurrect one when none is live.
//   - desired-state `dismissed`           → "the Lord stood the court down";
//                                            stay down, never resurrect.
// The marker is ABSENT ⇒ `running`, so a fresh throne self-heals by default.
//
// Resurrection relaunches the SAME harness kind (claude|codex) the Lord chose,
// recorded durably here (default claude if unrecorded).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HARNESS_NAMES,
  buildLaunchArgv,
  resolveModel,
  throneLauncherPath,
  type Harness,
} from "../harness-routing/harness.ts";
import {
  acquireResurrectLock,
  releaseResurrectLock,
} from "./regent-resurrect-lock.ts";
export {
  acquireResurrectLock,
  releaseResurrectLock,
  RESURRECT_LOCK_BASENAME,
  RESURRECT_LOCK_STALE_MS,
} from "./regent-resurrect-lock.ts";
import { PERSONA_CONFIG } from "../application-config.service.ts";
import {} from "../herdr/herdr-create.service.ts";
import { startAgent } from "../herdr/herdr-creation-orchestration.ts";
import { deliverOpeningPrompt } from "../herdr/herdr-opening-prompt.ts";
import { COMPOSER_RECOGNITION_TIMEOUT_MS } from "../herdr/herdr-send.types.ts";
import type { StartOptions } from "../herdr/herdr-create.contracts.ts";
import { RUNTIME_DATA_DIR } from "../shared-policy/runtime-data-home.ts";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import {
  REGENT_NAME,
  findLiveRegent,
  RegentLivenessVerdict,
  classifyRegentLiveness,
} from "./regent-liveness.ts";
import type { RegentLivenessClassification } from "./regent-liveness.ts";
import {
  DEFAULT_SPAWN_MARKER_WINDOW_MS,
  readSpawnMarkerAgeMs,
  SPAWN_MARKER_BASENAME,
  writeSpawnMarker,
} from "./regent-spawn-marker.ts";

export { REGENT_NAME, findLiveRegent, RegentLivenessVerdict };
export type { RegentLivenessClassification };
export {
  DEFAULT_SPAWN_MARKER_WINDOW_MS,
  SPAWN_MARKER_BASENAME,
  readSpawnMarkerAgeMs,
  writeSpawnMarker,
};

const REPO_ROOT = RUNTIME_THRONE_ROOT;

/** Throne repo root, resolved from this file's location (`src/regentstate.ts`). */
/** The Regent's durable state dir (gitignored) and its two marker files. */
export const REGENT_DIR = path.join(RUNTIME_DATA_DIR, "regent");
const DESIRED_STATE_BASENAME = "desired-state";
const HARNESS_BASENAME = "harness";
const ROUTE_BASENAME = "route.json";
/**
 * DWR (2026-08-14) gave every opening-prompt delivery a resident-draft wait
 * of `RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS` (15 minutes) before it force-
 * submits — the Lord's declared tolerance for a normal delivery, where no
 * other durable resource is on the line. `resurrectRegent`'s
 * `deliverOpeningPrompt` call is NOT a normal delivery: it runs while still
 * holding `acquireResurrectLock`, and `RESURRECT_LOCK_STALE_MS` (5 minutes,
 * above) is the TRIPWIRE — if this call ever blocked anywhere near 15
 * minutes, the lock would go stale and be reclaimed by a second, genuinely
 * independent resurrection attempt WHILE this one is still mid-delivery,
 * producing exactly the second-Regent hazard this whole module exists to
 * prevent. So this call must bound its own composer wait comfortably under
 * `RESURRECT_LOCK_STALE_MS`, and must not silently press Enter to force a
 * human's resident draft through on a pane that is meant to be a fresh
 * Regent's own first turn, not a live operator's composer — hence
 * `forceSubmitResidentDraftOnTimeout: false` alongside it. Reuses the
 * existing, already-tuned `COMPOSER_RECOGNITION_TIMEOUT_MS` (same pattern as
 * `send-agent-legacy`'s own `SEND_AGENT_LEGACY_COMPOSER_WAIT_MS`) rather than
 * inventing a fresh number.
 */
export const REGENT_RESURRECTION_COMPOSER_WAIT_MS =
  COMPOSER_RECOGNITION_TIMEOUT_MS;

export const DESIRED_STATES = {
  RUNNING: "running",
  DISMISSED: "dismissed",
} as const;
export type DesiredState = (typeof DESIRED_STATES)[keyof typeof DESIRED_STATES];
export type RegentHarness = Harness;
export interface RegentRoute {
  readonly harness: RegentHarness;
  readonly model: string;
}

/** Absent/garbage marker ⇒ keep the court alive (fail-safe). */
const DEFAULT_DESIRED_STATE: DesiredState = DESIRED_STATES.RUNNING;
/** Unrecorded harness ⇒ claude (AGENTS.md: the throne runs claude here). */
const DEFAULT_HARNESS: RegentHarness = HARNESS_NAMES.CLAUDE;

const RESURRECT_PROMPT =
  `You are the ${PERSONA_CONFIG.throneTitle.toLowerCase()} ${PERSONA_CONFIG.tierTitles.regent}, just resurrected by the keep-going watchdog after ` +
  `the previous ${PERSONA_CONFIG.tierTitles.regent} process died (crash/kill/reboot — the court self-heals). ` +
  "Perform your boot ritual NOW: read AGENTS.md (the durable court law) and " +
  `run render-queue (${PERSONA_CONFIG.queueDescription}), then run ` +
  "`./bin/throne-cli agent-statuses` to see the live court, reconcile any " +
  `in-flight work, and resume dispatching. You report outcomes to the ${PERSONA_CONFIG.addressTitle} and ` +
  "never put questions to him.";

/**
 * Read the Regent's desired state. Absent or unreadable marker ⇒ `running`
 * (fail-safe: a fresh or damaged throne should still self-heal); only the exact
 * word `dismissed` (case/space-insensitive) counts as dismissed, so a garbage
 * value can never silently stand the court down. `dir` is the injectable test
 * seam (defaults to the real `data/regent/`), mirroring the agent-data owners.
 */
export async function readDesiredState(
  dir: string = REGENT_DIR,
): Promise<DesiredState> {
  try {
    const raw = (await readFile(path.join(dir, DESIRED_STATE_BASENAME), "utf8"))
      .trim()
      .toLowerCase();
    return raw === DESIRED_STATES.DISMISSED
      ? DESIRED_STATES.DISMISSED
      : DEFAULT_DESIRED_STATE;
  } catch {
    return DEFAULT_DESIRED_STATE;
  }
}

/** Persist the Regent's desired state durably (creates `data/regent/` if absent). */
export async function writeDesiredState(
  state: DesiredState,
  dir: string = REGENT_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, DESIRED_STATE_BASENAME), `${state}\n`, "utf8");
}

/**
 * A one-line, human-facing description of what a desired-state MEANS for the
 * court's self-heal — the mode (UPPERCASED) plus the Lord control that flips it.
 * Shared by `agent-statuses` (its banner) and `throne-startup` (its boot digest)
 * so the two surfaces that report the mode never drift. Pure + total — a caller
 * prefixes its own context (e.g. `Regent desired-state: `).
 */
export function describeDesiredState(state: DesiredState): string {
  return state === DESIRED_STATES.DISMISSED
    ? "DISMISSED — the keep-going watchdog will NOT resurrect a dead Regent " +
        "(run `summon-regent` to bring the court back)."
    : "RUNNING — the keep-going watchdog resurrects a dead Regent " +
        "(run `dismiss-regent` to stand the court down).";
}

/**
 * Read the recorded Regent harness kind so resurrection relaunches the SAME
 * harness. Absent/unrecognized ⇒ `claude` (the default throne harness). `dir`
 * is the injectable test seam.
 */
export async function readRegentHarness(
  dir: string = REGENT_DIR,
): Promise<RegentHarness> {
  try {
    const raw = (await readFile(path.join(dir, HARNESS_BASENAME), "utf8"))
      .trim()
      .toLowerCase();
    return raw === HARNESS_NAMES.CODEX ? HARNESS_NAMES.CODEX : DEFAULT_HARNESS;
  } catch {
    return DEFAULT_HARNESS;
  }
}

/** Record the Regent harness kind durably (creates `data/regent/` if absent). */
export async function writeRegentHarness(
  harness: RegentHarness,
  dir: string = REGENT_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, HARNESS_BASENAME), `${harness}\n`, "utf8");
}

export async function readRegentRoute(
  dir: string = REGENT_DIR,
): Promise<RegentRoute | undefined> {
  try {
    const candidate = JSON.parse(
      await readFile(path.join(dir, ROUTE_BASENAME), "utf8"),
    ) as Partial<RegentRoute>;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.harness !== "string" ||
      typeof candidate.model !== "string"
    ) {
      return undefined;
    }
    const harness = candidate.harness as RegentHarness;
    return { harness, model: resolveModel(harness, candidate.model) };
  } catch {
    return undefined;
  }
}

export async function writeRegentRoute(
  route: RegentRoute,
  dir: string = REGENT_DIR,
): Promise<void> {
  const model = resolveModel(route.harness, route.model);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, ROUTE_BASENAME),
    `${JSON.stringify({ harness: route.harness, model })}\n`,
    "utf8",
  );
}

/** Injectable seam for `resurrectRegent` — defaults to the real launch stack. */
export interface ResurrectDeps {
  startAgent: typeof startAgent;
  deliverOpeningPrompt: typeof deliverOpeningPrompt;
  readRegentHarness: (dir?: string) => Promise<RegentHarness>;
  readRegentRoute: (dir?: string) => Promise<RegentRoute | undefined>;
  findLiveRegent: typeof findLiveRegent;
  writeStderr: (text: string) => void;
  throneRoot: string;
  regentDir: string;
  /** See `DEFAULT_SPAWN_MARKER_WINDOW_MS`. Injectable so tests can exercise
   * both "inside the window" (herdr registration lag) and "past the window"
   * (a genuinely dead Regent must still be resurrected) deterministically. */
  spawnMarkerWindowMs: number;
}

const REAL_RESURRECT_DEPS: ResurrectDeps = {
  startAgent,
  deliverOpeningPrompt,
  readRegentHarness,
  readRegentRoute,
  findLiveRegent,
  writeStderr: (text) => process.stderr.write(text),
  throneRoot: REPO_ROOT,
  regentDir: REGENT_DIR,
  spawnMarkerWindowMs: DEFAULT_SPAWN_MARKER_WINDOW_MS,
};

/**
 * Launch a fresh throne Regent harness in its own tab, rooted at the throne
 * root, gated on a pre-spawn re-check of `deps.findLiveRegent()` performed
 * while holding the cross-process resurrection lock (`acquireResurrectLock`)
 * — so a Regent that came alive after an earlier, looser-timed caller check
 * (the watchdog's enqueue-time check, or `summon-regent`'s own check) is not
 * duplicated, AND a second, fully independent process running this same
 * function concurrently cannot land its own check inside this call's
 * check-then-spawn window either:
 *   - Confirmed live → return without spawning.
 *   - Confirmed absent → spawn, unconditionally (every "genuinely dead"
 *     framing — stale pane id, stripped name field, ledger-present-process-
 *     gone — reaches this branch; it must never be skipped).
 *   - Ambiguous (`findLiveRegent` rejects with more than one tab carrying the
 *     exact `Regent` label) → do NOT spawn; a duplicate here would make the
 *     defect recursive. Write a loud stderr diagnostic instead so a human
 *     reconciles the existing duplicate(s) by hand.
 *   - Any other rejection (genuine infrastructure failure — herdr
 *     unreachable, etc.) → true uncertainty, so spawn: an unresurrected court
 *     is unrecoverable, a duplicate Regent is not.
 *
 * herdr's `agent start` REQUIRES a positional name — there is no nameless
 * launch — so the harness starts directly under the name `Regent`; its
 * SessionStart `throne-startup` hook then takes the already-`Regent` self-heal
 * branch (claim the tab, arm the heartbeat, print the QUEUE digest), so naming
 * it here is equivalent to a fresh manual launch that renames itself. The
 * recorded harness kind picks the throne-owned launcher (`bin/claudey` or
 * `bin/codexy`, via `throneLauncherPath`) so the SAME harness the Lord chose
 * comes back — through the same launcher stack every other spawn uses.
 */
export async function resurrectRegent(
  deps: ResurrectDeps = REAL_RESURRECT_DEPS,
): Promise<void> {
  // The lock is held across the ENTIRE check-then-spawn window (not just
  // around `startAgent`) so a second, independent process's liveness check
  // can never land inside the gap between this call's own check and its
  // spawn — the actual cross-process TOCTOU: `classifyRegentLiveness`'s
  // `findLiveRegent` call and the eventual `startAgent` call are separated by
  // multiple `await` points, and each process's herdr resolution only sees
  // agents that have ALREADY finished starting, so two processes racing
  // through that gap both observe Absent independently.
  const lockToken = await acquireResurrectLock(deps.regentDir);
  if (lockToken === null) {
    deps.writeStderr(
      "resurrectRegent: another resurrection is already in progress " +
        "(cross-process lock held); skipping this cycle to avoid a " +
        "duplicate spawn.\n",
    );
    return;
  }
  try {
    const { verdict, markerAgeMs } = await classifyRegentLiveness(deps);
    if (verdict === RegentLivenessVerdict.Live) {
      return;
    }
    if (verdict === RegentLivenessVerdict.RecentlySpawned) {
      // The one number nobody has measured (DEFAULT_SPAWN_MARKER_WINDOW_MS)
      // is only a hypothesis until it has telemetry. Log every fire with the
      // marker's actual age so the real herdr-visibility-lag distribution
      // accumulates over time, instead of staying an unvalidated guess.
      deps.writeStderr(
        "resurrectRegent: herdr does not show a live Regent yet, but a " +
          `spawn marker committed ${markerAgeMs}ms ago (window ` +
          `${deps.spawnMarkerWindowMs}ms) — treating this as herdr ` +
          "registration lag, not a dead court; skipping this cycle.\n",
      );
      return;
    }
    if (verdict === RegentLivenessVerdict.Ambiguous) {
      deps.writeStderr(
        `resurrectRegent: more than one tab carries the exact "${REGENT_NAME}" ` +
          "label — a Regent already exists (or two do). Refusing to spawn a " +
          "third; reconcile the duplicate(s) by hand.\n",
      );
      return;
    }
    if (verdict === RegentLivenessVerdict.Absent && markerAgeMs !== null) {
      // A marker existed but was already past the window — a near-miss: the
      // window was close to too small. Log it (cheap — this branch is rare)
      // so a run of these is the signal that DEFAULT_SPAWN_MARKER_WINDOW_MS
      // needs raising, rather than a silently reopened duplicate-spawn gap.
      deps.writeStderr(
        `resurrectRegent: spawn marker found but ${markerAgeMs}ms old, past ` +
          `the ${deps.spawnMarkerWindowMs}ms visibility window — trusting ` +
          "herdr's Absent and resurrecting; if this recurs the window is " +
          "probably too small.\n",
      );
    }
    // verdict is Absent or Uncertain — commit to spawning. Write the marker
    // BEFORE startAgent, still holding the lock, so any independent process
    // that lands its own check after this call releases the lock (below)
    // sees the marker rather than a bare herdr Absent.
    await writeSpawnMarker(deps.regentDir);
    const route = await deps.readRegentRoute(deps.regentDir);
    const harness = route?.harness ?? await deps.readRegentHarness(deps.regentDir);
    const argv = route === undefined
      ? [throneLauncherPath(harness === HARNESS_NAMES.CODEX ? "codexy" : "claudey")]
      : buildLaunchArgv({ harness: route.harness, model: route.model, effort: 1 });
    const opts: StartOptions = {
      cwd: deps.throneRoot,
      argv,
    };
    await deps.startAgent(REGENT_NAME, opts);
    await deps.deliverOpeningPrompt(REGENT_NAME, RESURRECT_PROMPT, {
      composerWaitMilliseconds: REGENT_RESURRECTION_COMPOSER_WAIT_MS,
      forceSubmitResidentDraftOnTimeout: false,
    });
  } finally {
    await releaseResurrectLock(deps.regentDir, lockToken);
  }
}

@Injectable()
export class RegentStateService {
  readonly readDesiredState = readDesiredState;
  readonly writeDesiredState = writeDesiredState;
  readonly describeDesiredState = describeDesiredState;
  readonly readRegentHarness = readRegentHarness;
  readonly writeRegentHarness = writeRegentHarness;
  readonly readRegentRoute = readRegentRoute;
  readonly writeRegentRoute = writeRegentRoute;
  readonly findLiveRegent = findLiveRegent;
  readonly resurrectRegent = resurrectRegent;
}
