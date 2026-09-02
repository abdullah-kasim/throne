import { inspectSupportedAgentScreen } from "../codex-screen/composer/composer.service.ts";
import { unresolvedComposerDeadlineMessage } from "./herdr-composer-deadline-message.ts";
import { composerUnavailableTimeoutMessage } from "./herdr-composer-diagnostic-capture.ts";
import type { SupportedAgentScreenSnapshot, SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
import {
  codexScreenShowsActiveTurn,
  observeCodexScreenV1,
  type CodexScreenDiagnostic,
} from "../codex-screen/codex-screen.ts";
import {
  HARNESSES,
  HARNESS_EXECUTABLE_NAMES,
  HARNESS_NAMES,
} from "../harness-routing/harness.ts";
import { dismissFasterModelInterruption } from "../shared-policy/faster-model-dismiss.ts";
import {
  getPaneProcessInfo,
} from "./herdr-runtime.service.ts";
import { CODEX_HERDR_READ_TIMEOUT_MS, runHerdr, type HerdrProcessBoundary } from "./herdr-client.ts";
import type { HerdrForegroundProcess, HerdrPaneProcessInfo, ReadSource } from "./herdr-inventory.service.ts";
import {
  IncompleteHerdrPaneProcessInfoError,
  parseReadText,
  type HerdrAgent,
} from "./herdr-inventory.service.ts";
import {
  DEFAULT_HERDR_PROCESS_BOUNDARY,
  DEFAULT_HERDR_RUNTIME_MODE,
} from "./herdr-client.ts";
import {
  argvExecutableCandidates,
  executableName,
  isRegisteredHarnessProcess,
  paneHasExternalInteractiveProcess,
} from "./herdr-process-detection.ts";
import {
  COMPOSER_VISIBILITY_POLL_MS,
  COMPOSER_VISIBILITY_TIMEOUT_MS,
  RESIDENT_COMPOSER_POLL_MS,
  type PressEnterUntilEmptyTextboxDeps,
  type SubmitToAgentDeps,
} from "./herdr-send.types.ts";
import { Injectable } from '@nestjs/common';
async function readAgentOutput(
  target: string,
  source: ReadSource,
  format: "ansi" | "text",
  lines?: number,
  processBoundary: HerdrProcessBoundary = DEFAULT_HERDR_PROCESS_BOUNDARY,
  timeoutMilliseconds?: number,
): Promise<string> {
  const args = [
    "agent",
    "read",
    target,
    "--source",
    source,
    "--format",
    format,
  ];
  if (lines !== undefined) args.push("--lines", String(lines));
  const { stdout } = await runHerdr(
    args,
    processBoundary,
    DEFAULT_HERDR_RUNTIME_MODE,
    timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds },
  );
  return parseReadText(stdout);
}

export async function readVisibleAgentAnsi(
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutput(target, "visible", "ansi", undefined, processBoundary);
}

export async function readVisibleCodexAgentAnsi(
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutput(
    target,
    "visible",
    "ansi",
    undefined,
    processBoundary,
    CODEX_HERDR_READ_TIMEOUT_MS,
  );
}

export async function readVisibleAgentText(target: string): Promise<string> {
  return readAgentOutput(target, "visible", "text");
}

export async function readRecentAgentAnsi(
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutput(target, "recent", "ansi", 1_000, processBoundary);
}

export async function readRecentCodexAgentAnsi(
  target: string,
  processBoundary?: HerdrProcessBoundary,
): Promise<string> {
  return readAgentOutput(
    target,
    "recent",
    "ansi",
    1_000,
    processBoundary,
    CODEX_HERDR_READ_TIMEOUT_MS,
  );
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function pollForVisibleEffect(
  predicate: () => Promise<boolean>,
  deps: SubmitToAgentDeps,
): Promise<boolean> {
  const startedAt = deps.now();
  let lastObservationFailed = false;
  let lastObservationError: unknown;
  while (true) {
    try {
      if (await predicate()) return true;
      lastObservationFailed = false;
      lastObservationError = undefined;
    } catch (error) {
      lastObservationFailed = true;
      lastObservationError = error;
    }
    const remaining = COMPOSER_VISIBILITY_TIMEOUT_MS - (deps.now() - startedAt);
    if (remaining <= 0) {
      if (lastObservationFailed) throw lastObservationError;
      return false;
    }
    await deps.sleep(Math.min(COMPOSER_VISIBILITY_POLL_MS, remaining));
  }
}

export function supportedComposerHarness(
  harness: string,
): SupportedComposerHarness | undefined {
  return HARNESSES.find((candidate) => candidate === harness);
}

export const SUPPORTED_HARNESS_EXECUTABLES: Readonly<
  Record<SupportedComposerHarness, ReadonlySet<string>>
> = {
  [HARNESS_NAMES.CLAUDE]: new Set(
    HARNESS_EXECUTABLE_NAMES[HARNESS_NAMES.CLAUDE],
  ),
  [HARNESS_NAMES.CODEX]: new Set(HARNESS_EXECUTABLE_NAMES[HARNESS_NAMES.CODEX]),
  [HARNESS_NAMES.OPENCODE]: new Set(
    HARNESS_EXECUTABLE_NAMES[HARNESS_NAMES.OPENCODE],
  ),
  [HARNESS_NAMES.CLAUDEY_ALL_OMNI]: new Set(
    HARNESS_EXECUTABLE_NAMES[HARNESS_NAMES.CLAUDEY_ALL_OMNI],
  ),
  [HARNESS_NAMES.CODEXY_ALL_OMNI]: new Set(
    HARNESS_EXECUTABLE_NAMES[HARNESS_NAMES.CODEXY_ALL_OMNI],
  ),
  [HARNESS_NAMES.OMP]: new Set(HARNESS_EXECUTABLE_NAMES[HARNESS_NAMES.OMP]),
};

function paneHasExpectedHarnessProcess(
  processInfo: HerdrPaneProcessInfo,
  harness: SupportedComposerHarness,
): boolean {
  return processInfo.foregroundProcesses.some((process) =>
    isRegisteredHarnessProcess(harness, process),
  );
}

export interface SupportedScreenObservationDeps {
  getPaneProcessInfo: typeof getPaneProcessInfo;
  readVisibleAgentAnsi: typeof readVisibleAgentAnsi;
  readVisibleCodexAgentAnsi?: typeof readVisibleCodexAgentAnsi;
}

function readCodexVisibleAnsi(
  deps: Pick<
    SubmitToAgentDeps,
    "readVisibleAgentAnsi" | "readVisibleCodexAgentAnsi"
  >,
  target: string,
): Promise<string> {
  return (deps.readVisibleCodexAgentAnsi ?? deps.readVisibleAgentAnsi)(target);
}

function readCodexRecentAnsi(
  deps: Pick<
    SubmitToAgentDeps,
    "readRecentAgentAnsi" | "readRecentCodexAgentAnsi"
  >,
  target: string,
): Promise<string> {
  return (deps.readRecentCodexAgentAnsi ?? deps.readRecentAgentAnsi)(target);
}

export class CodexScreenObservationError extends Error {
  readonly diagnostic: CodexScreenDiagnostic;
  readonly visibleAnsi?: string;

  constructor(diagnostic: CodexScreenDiagnostic, visibleAnsi?: string) {
    const { adapterVersion, code, surface, detail } = diagnostic;
    super(
      `Codex screen adapter v${adapterVersion} rejected ${surface} ` +
        `(${code}): ${detail}`,
    );
    this.diagnostic = diagnostic;
    this.visibleAnsi = visibleAnsi;
  }
}

function requireCodexScreenObservation(
  observation: ReturnType<typeof observeCodexScreenV1>,
  visibleAnsi?: string,
): SupportedAgentScreenSnapshot {
  if (observation.kind === "observed") return observation.snapshot;
  throw new CodexScreenObservationError(observation.diagnostic, visibleAnsi);
}

export interface SupportedScreenReading {
  snapshot: SupportedAgentScreenSnapshot;
  visibleAnsi: string;
}

export async function observeSupportedScreenWithVisibleAnsi(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  deps: SupportedScreenObservationDeps,
): Promise<SupportedScreenReading> {
  const processInfo = await deps.getPaneProcessInfo(agent.paneId);
  if (harness === HARNESS_NAMES.CODEX) {
    const visibleAnsi = await readCodexVisibleAnsi(deps, agent.paneId);
    return {
      snapshot: requireCodexScreenObservation(
        observeCodexScreenV1({
          expectedPaneId: agent.paneId,
          processInfo,
          visibleAnsi,
        }),
        visibleAnsi,
      ),
      visibleAnsi,
    };
  }
  if (processInfo.paneId !== agent.paneId) {
    throw new Error(
      `pane authority changed: expected "${agent.paneId}", observed ` +
        `"${processInfo.paneId}"`,
    );
  }
  if (paneHasExternalInteractiveProcess(processInfo)) {
    throw new Error(
      `pane "${agent.paneId}" is controlled by an external editor/modal`,
    );
  }
  if (!paneHasExpectedHarnessProcess(processInfo, harness)) {
    throw new Error(
      `pane "${agent.paneId}" no longer owns the expected ${harness} harness`,
    );
  }
  const visibleAnsi = await deps.readVisibleAgentAnsi(agent.paneId);
  return {
    snapshot: inspectSupportedAgentScreen(harness, visibleAnsi),
    visibleAnsi,
  };
}

export async function observeSupportedScreen(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  deps: SupportedScreenObservationDeps,
): Promise<SupportedAgentScreenSnapshot> {
  return (await observeSupportedScreenWithVisibleAnsi(agent, harness, deps))
    .snapshot;
}

export function observationFailureForbidsKeys(error: unknown): boolean {
  return !(
    error instanceof CodexScreenObservationError &&
    error.diagnostic.code === "active-composer-unrecognized"
  );
}

export async function observeClaudeRecentScreen(
  agent: HerdrAgent,
  deps: Pick<SubmitToAgentDeps, "readRecentAgentAnsi">,
): Promise<SupportedAgentScreenSnapshot> {
  return inspectSupportedAgentScreen(
    HARNESS_NAMES.CLAUDE,
    await deps.readRecentAgentAnsi(agent.paneId),
  );
}

export interface CodexScreenReading {
  snapshot: SupportedAgentScreenSnapshot;
  visibleAnsi: string;
}
export async function observeCodexScreenWithRecentPrompts(
  agent: HerdrAgent,
  deps: PressEnterUntilEmptyTextboxDeps,
): Promise<CodexScreenReading> {
  const processInfo = await deps.getPaneProcessInfo(agent.paneId);
  const visibleAnsi = await readCodexVisibleAnsi(deps, agent.paneId);
  return {
    snapshot: requireCodexScreenObservation(
      observeCodexScreenV1({
        expectedPaneId: agent.paneId,
        processInfo,
        visibleAnsi,
        recentAnsi: await readCodexRecentAnsi(deps, agent.paneId),
      }),
      visibleAnsi,
    ),
    visibleAnsi,
  };
}

export function isTransientComposerObservationFailure(error: unknown): boolean {
  return (
    error instanceof IncompleteHerdrPaneProcessInfoError ||
    (error instanceof CodexScreenObservationError &&
      error.diagnostic.code === "active-composer-unrecognized")
  );
}

export async function waitForRecognizedComposer(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<SupportedAgentScreenSnapshot> {
  let lastVisibleAnsi: string | undefined;
  while (true) {
    try {
      const observed = await observeSupportedScreenWithVisibleAnsi(agent, harness, deps);
      lastVisibleAnsi = observed.visibleAnsi;
      if (observed.snapshot.activeComposer.state !== "unavailable") return observed.snapshot;
    } catch (error) {
      const remaining = deadline - deps.now();
      if (!isTransientComposerObservationFailure(error) || remaining <= 0) {
        throw error;
      }
      if (
        harness === HARNESS_NAMES.CODEX &&
        error instanceof CodexScreenObservationError &&
        error.visibleAnsi !== undefined &&
        (await dismissFasterModelInterruption(agent, deps, error.visibleAnsi))
      ) {
        continue;
      }
      await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
      continue;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        await composerUnavailableTimeoutMessage(
          agent.name ?? agent.terminalId,
          lastVisibleAnsi,
          deps.captureComposerDiagnostic,
        ),
      );
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

export async function waitForEmptyComposer(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<SupportedAgentScreenSnapshot> {
  while (true) {
    const snapshot = await waitForRecognizedComposer(
      agent,
      harness,
      deadline,
      deps,
    );
    const { activeComposer } = snapshot;
    if (activeComposer.state === "empty") return snapshot;
    // A resident draft is a wait condition, never an error: the Lord may be
    // mid-sentence, and his draft outranks every agent in the court. The
    // menu chrome a harness parks itself at is likewise never delivered
    // into — only the reported failure differs between the two.
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(unresolvedComposerDeadlineMessage(activeComposer));
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

export async function observeCodexStartupFrame(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<CodexScreenReading & { activeTurn: boolean }> {
  const visibleAnsi = await readCodexVisibleAnsi(deps, agent.paneId);
  return {
    snapshot: requireCodexScreenObservation(
      observeCodexScreenV1({
        expectedPaneId: agent.paneId,
        processInfo: await deps.getPaneProcessInfo(agent.paneId),
        visibleAnsi,
        recentAnsi: await readCodexRecentAnsi(deps, agent.paneId),
      }),
      visibleAnsi,
    ),
    visibleAnsi,
    activeTurn: codexScreenShowsActiveTurn(visibleAnsi),
  };
}

export function sameScreenTextEntries(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export async function waitForSettledCodexComposer(
  agent: HerdrAgent,
  deadline: number,
  deps: SubmitToAgentDeps,
): Promise<SupportedAgentScreenSnapshot> {
  let previousSettledFrame: SupportedAgentScreenSnapshot | undefined;
  while (true) {
    try {
      const frame = await observeCodexStartupFrame(agent, deps);
      const settled =
        frame.snapshot.activeComposer.state === "empty" && !frame.activeTurn;
      const stable =
        settled &&
        previousSettledFrame !== undefined &&
        sameScreenTextEntries(
          previousSettledFrame.promptTexts,
          frame.snapshot.promptTexts,
        ) &&
        sameScreenTextEntries(
          previousSettledFrame.codexQueuedTexts,
          frame.snapshot.codexQueuedTexts,
        ) &&
        sameScreenTextEntries(
          previousSettledFrame.codexPendingTexts,
          frame.snapshot.codexPendingTexts,
        );
      if (stable) return frame.snapshot;
      previousSettledFrame = settled ? frame.snapshot : undefined;
    } catch (error) {
      if (!isTransientComposerObservationFailure(error)) throw error;
      previousSettledFrame = undefined;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        "Codex startup did not settle before the composer deadline; nothing was written",
      );
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

/** Injectable owner for screen reads, parsing, and composer readiness effects. */
@Injectable()
export class HerdrScreenService {
  readVisibleAgentAnsi = readVisibleAgentAnsi;
  readVisibleCodexAgentAnsi = readVisibleCodexAgentAnsi;
  readVisibleAgentText = readVisibleAgentText;
  readRecentAgentAnsi = readRecentAgentAnsi;
  readRecentCodexAgentAnsi = readRecentCodexAgentAnsi;
  observeSupportedScreen = observeSupportedScreen;
  observeSupportedScreenWithVisibleAnsi = observeSupportedScreenWithVisibleAnsi;
  observeCodexScreenWithRecentPrompts = observeCodexScreenWithRecentPrompts;
  waitForRecognizedComposer = waitForRecognizedComposer;
  waitForEmptyComposer = waitForEmptyComposer;
  waitForSettledCodexComposer = waitForSettledCodexComposer;
}
