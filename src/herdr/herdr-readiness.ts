import { errorText } from "../shared-policy/error-text.ts";
import { sleep } from "./herdr-screen.service.ts";
import { runHerdr } from "./herdr-client.ts";
import { HerdrCommandError } from "./herdr-client.ts";
import type { HerdrPane } from "./herdr-inventory.service.ts";
import { parseReadText } from "./herdr-inventory.service.ts";
import type {
  ShellReadyEvidence,
  StartEvidencePhase,
} from "./herdr-create.contracts.ts";
import {
  SHELL_READY_TIMEOUT_MS,
  SHELL_READY_PROBE_WINDOW_MS,
  SHELL_READY_CAPTURE_LINES,
  SHELL_READY_PROBE_COMMAND_MARKER,
} from "./herdr-launch.ts";
import { hideFromBashHistory } from "./herdr-launch-command.ts";

export class PaneReadinessTimeoutError extends Error {
  readonly name = "PaneReadinessTimeoutError";
  readonly paneId: string;
  readonly timeoutMs: number;
  readonly phase: StartEvidencePhase;
  readonly outputBytes: number;
  readonly observations: number;

  constructor(
    paneId: string,
    timeoutMs: number,
    cause?: unknown,
    reached: {
      phase?: StartEvidencePhase;
      outputBytes?: number;
      observations?: number;
    } = {},
  ) {
    const phase = reached.phase ?? "tab-created";
    const outputBytes = reached.outputBytes ?? 0;
    super(
      `herdr pane "${paneId}" never presented a ready shell within ${timeoutMs}ms ` +
        `(furthest phase "${phase}", ${outputBytes} bytes of pane output observed); ` +
        "no agent launch was issued",
      cause === undefined ? undefined : { cause },
    );
    this.paneId = paneId;
    this.timeoutMs = timeoutMs;
    this.phase = phase;
    this.outputBytes = outputBytes;
    this.observations = reached.observations ?? 0;
  }
}

async function capturePaneText(
  paneId: string,
  deps: { runHerdr: typeof runHerdr },
): Promise<string> {
  const { stdout } = await deps.runHerdr([
    "pane",
    "read",
    paneId,
    "--source",
    "recent",
    "--format",
    "text",
    "--lines",
    String(SHELL_READY_CAPTURE_LINES),
  ]);
  return parseReadText(stdout);
}

export function paneOutputBytes(capture: string): number {
  return Buffer.byteLength(capture.trim(), "utf8");
}

export function captureProvesExecutedSentinel(
  capture: string,
  sentinel: string,
): boolean {
  return capture
    .split("\n")
    .filter((line) => !line.includes(SHELL_READY_PROBE_COMMAND_MARKER))
    .some((line) => line.includes(sentinel));
}

export async function waitForShellReady(
  paneId: string,
  deps: { runHerdr: typeof runHerdr; now: () => number } = {
    runHerdr,
    now: Date.now,
  },
  timeoutMs: number = SHELL_READY_TIMEOUT_MS,
): Promise<ShellReadyEvidence> {
  const nonce = Math.random().toString(36).slice(2, 10);
  const sentinel = `THRONE_SHELL_READY_${nonce}`;
  const probe = hideFromBashHistory(`${SHELL_READY_PROBE_COMMAND_MARKER} ${nonce}`);
  const startedAt = deps.now();
  const deadline = startedAt + timeoutMs;
  let lastFailure: unknown;
  let phase: StartEvidencePhase = "tab-created";
  let outputBytes = 0;
  let probeWrites = 0;
  let observations = 0;

  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new PaneReadinessTimeoutError(paneId, timeoutMs, lastFailure, {
        phase,
        outputBytes,
        observations,
      });
    }
    try {
      await deps.runHerdr(["pane", "send-text", paneId, probe]);
      await deps.runHerdr(["pane", "send-keys", paneId, "Enter"]);
      probeWrites += 1;
    } catch (error) {
      lastFailure = error;
    }
    observations += 1;
    let matched = false;
    try {
      await deps.runHerdr([
        "pane",
        "wait-output",
        paneId,
        "--match",
        sentinel,
        "--timeout",
        String(Math.min(SHELL_READY_PROBE_WINDOW_MS, Math.max(1, remaining))),
      ]);
      matched = true;
    } catch (error) {
      lastFailure = error;
    }
    let capture = "";
    try {
      capture = await capturePaneText(paneId, deps);
    } catch (error) {
      lastFailure = error;
    }
    const bytes = paneOutputBytes(capture);
    if (bytes > outputBytes) {
      outputBytes = bytes;
    }
    if (bytes > 0 && phase === "tab-created") {
      phase = "pane-output-observed";
    }
    if (!matched) {
      continue;
    }
    if (bytes === 0) {
      lastFailure = new Error(
        `herdr pane "${paneId}" matched the readiness sentinel but read back an ` +
          "empty transcript; an empty capture is not evidence of a live shell",
      );
      continue;
    }
    if (!captureProvesExecutedSentinel(capture, sentinel)) {
      lastFailure = new Error(
        `herdr pane "${paneId}" shows the readiness sentinel only on the typed ` +
          "command line; echoed input is not evidence that a shell executed it",
      );
      continue;
    }
    return {
      paneId,
      phase: "sentinel-executed",
      sentinel,
      sentinelExecuted: true,
      outputBytes,
      probeWrites,
      observations,
      elapsedMs: deps.now() - startedAt,
    };
  }
}
