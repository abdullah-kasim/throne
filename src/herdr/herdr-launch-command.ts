import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_NAMES, runtimeHarness } from "../harness-routing/harness.ts";
import {
  argvExecutableCandidates,
  executableName,
} from "./herdr-process-detection.ts";
import { parseAgentList } from "./herdr-inventory.service.ts";
import {
  SUPPORTED_HARNESS_EXECUTABLES,
  sleep,
} from "./herdr-screen.service.ts";
import { HerdrCommandError, runHerdr } from "./herdr-client.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { grantThroneWorktreeTrust } from "../claude-spawn-trust/claude-worktree-trust.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import type { StartInTabDeps, StartOptions } from "./herdr-create.contracts.ts";
import type { SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
interface LaunchContext {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stagedArtifactPaths?: string[];
  binaryResolution?: HarnessBinaryResolution;
}
interface HarnessBinaryResolution {
  executableName: typeof HARNESS_NAMES.CLAUDE;
  overrideVariable: "CLAUDE_BIN";
  wrapperName: "claudey-all";
}
export const AGENT_DETECTION_TIMEOUT_MS = 15_000;
export const AGENT_DETECTION_POLL_MS = 100;
const LAUNCHER_LIBRARY_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "bin",
  "agent-launcher-lib.sh",
);
const CLAUDE_RUNTIME_MODEL_SETTINGS = JSON.stringify({
  switchModelsOnFlag: false,
});

export class AgentDetectionTimeoutError extends Error {
  readonly name = "AgentDetectionTimeoutError";
  readonly paneId: string;
  readonly expectedKind: SupportedComposerHarness;
  readonly timeoutMs: number;

  constructor(
    paneId: string,
    expectedKind: SupportedComposerHarness,
    timeoutMs: number,
    cause?: unknown,
  ) {
    super(
      `herdr did not detect a ${expectedKind} harness in pane "${paneId}" within ${timeoutMs}ms`,
      cause === undefined ? undefined : { cause },
    );
    this.paneId = paneId;
    this.expectedKind = expectedKind;
    this.timeoutMs = timeoutMs;
  }
}

export class HarnessLaunchIssuedError extends Error {
  readonly name = "HarnessLaunchIssuedError";

  constructor(cause: unknown) {
    super(
      `direct harness launch failed after the pane command was issued: ${errorText(cause)}`,
      { cause },
    );
  }
}

function claudeyAllCompactWindow(ceiling: number, percent: number): string {
  return String(Math.floor((ceiling * percent) / 100));
}

function sanitizedLaunchArgs(argv: readonly string[]): string[] {
  return argv.map((arg) => arg.replace(/\s*\r?\n\s*/g, " "));
}

function writeClaudeyAllSettings(model: string): {
  settingsPath: string;
  settingsDir: string;
} {
  const settingsRoot = path.join(os.homedir(), "tmp");
  mkdirSync(settingsRoot, { recursive: true, mode: 0o700 });
  const settingsDir = mkdtempSync(
    path.join(settingsRoot, "throne-herdr-claudey-all-"),
  );
  chmodSync(settingsDir, 0o700);
  const settingsPath = path.join(settingsDir, "settings.json");
  const cliproxyHost = process.env.CLIPROXY_HOST?.trim() || "127.0.0.1";
  const cliproxyPort = process.env.CLIPROXY_PORT?.trim() || "8317";
  const cliproxyKeyFile =
    process.env.CLIPROXY_KEY_FILE?.trim() ||
    path.join(os.homedir(), ".cli-proxy-api", "client.key");
  const ceiling = Number.parseInt(
    process.env.CLAUDEY_ALL_CONTEXT_TOKENS ?? "",
    10,
  );
  const contextCeiling =
    Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 200000;
  const percent = Number.parseInt(
    process.env.CLAUDEY_ALL_COMPACT_PERCENT ?? "",
    10,
  );
  const compactPercent =
    Number.isInteger(percent) && percent > 0 ? percent : 90;
  const settings = {
    switchModelsOnFlag: false,
    env: {
      ANTHROPIC_BASE_URL: `http://${cliproxyHost}:${cliproxyPort}`,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS:
        process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? String(contextCeiling),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW:
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ??
        claudeyAllCompactWindow(contextCeiling, compactPercent),
    },
    apiKeyHelper: `head -1 ${JSON.stringify(cliproxyKeyFile)}`,
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(settingsPath, 0o600);
  return {
    settingsPath,
    settingsDir,
  };
}

export function launcherHarnessKind(
  opts: StartOptions,
): SupportedComposerHarness {
  const candidates = argvExecutableCandidates(opts.argv);
  for (const [harness, executables] of Object.entries(
    SUPPORTED_HARNESS_EXECUTABLES,
  ) as [SupportedComposerHarness, ReadonlySet<string>][]) {
    if (candidates.some((name) => executables.has(name))) {
      return runtimeHarness(harness);
    }
  }
  throw new Error(
    `unsupported throne launcher "${executableName(opts.argv[0] ?? "")}"`,
  );
}

// Only the throne's own `claudey` launcher, invoked by throne's herdr launch
// path (never a human running `claudey`/`claude` by hand outside it — see
// `startInTab`'s callers), reaches this function; a human launch never does.
//
// It sets NO `CLAUDE_CONFIG_DIR`: a throne-spawned agent uses the account's
// REAL config, exactly as the human's own sessions do. Per-spawn config
// directories were removed because each one presents as a separate client
// installation on a single credential, which expires logins aggressively
// (2026-08-15/16: three agents wedged on `Login expired`, seven seed
// directories live at once). What the seed was actually buying is now
// obtained without it — the two permission modals are already suppressed by
// the account's own `settings.json`, and the untrusted-folder modal is
// suppressed by granting per-project trust in the real config below.
function claudeyLaunchContext(opts: StartOptions): LaunchContext {
  const argv = [
    ...sanitizedLaunchArgs(opts.argv),
    "--settings",
    CLAUDE_RUNTIME_MODEL_SETTINGS,
  ];
  if (opts.cwd === undefined) {
    return { argv };
  }
  // Fails loudly rather than launching into an invisible modal: a spawn whose
  // trust grant did not land blocks on a dialog no operator can see or answer.
  grantThroneWorktreeTrust(opts.cwd);
  return { argv };
}

export function translatedLaunchContext(opts: StartOptions): LaunchContext {
  const launcher = opts.argv[0]?.split("/").at(-1);
  if (launcher === "claudey") {
    return claudeyLaunchContext(opts);
  }
  if (launcher !== "claudey-all") {
    return { argv: sanitizedLaunchArgs(opts.argv) };
  }
  const modelFlagIndex = opts.argv.findIndex((arg) => arg === "--model");
  const model = opts.argv[modelFlagIndex + 1];
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("claudey-all launch is missing its --model value");
  }
  const remainingArgs = [
    ...opts.argv.slice(1, modelFlagIndex),
    ...opts.argv.slice(modelFlagIndex + 2),
  ];
  const { settingsPath, settingsDir } = writeClaudeyAllSettings(model);
  return {
    argv: [
      HARNESS_NAMES.CLAUDE,
      "--settings",
      settingsPath,
      "--bare",
      "--model",
      model,
      ...sanitizedLaunchArgs(remainingArgs),
    ],
    stagedArtifactPaths: [settingsDir],
    binaryResolution: {
      executableName: HARNESS_NAMES.CLAUDE,
      overrideVariable: "CLAUDE_BIN",
      wrapperName: "claudey-all",
    },
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function hideFromBashHistory(command: string): string {
  return ` ${command}`;
}

function harnessLifetimeCleanupScript(
  stagedArtifactPaths: readonly string[],
): string[] {
  const reaperProgram = [
    "harness_pid=$1",
    "shift",
    'while kill -0 "$harness_pid" 2>/dev/null; do',
    "  sleep 1",
    "done",
    'rm -rf -- "$@"',
  ].join("\n");
  return [
    "harness_pid=$$",
    `{ setsid bash -c ${shellQuote(reaperProgram)} throne-reaper "$harness_pid" ${stagedArtifactPaths.map(shellQuote).join(" ")} </dev/null >/dev/null 2>&1 & } || :`,
  ];
}

function harnessBinaryResolutionScript(
  resolution: HarnessBinaryResolution | undefined,
): string[] {
  if (resolution === undefined) {
    return [];
  }
  const overrideValue = `\${${resolution.overrideVariable}:-}`;
  return [
    `. ${shellQuote(LAUNCHER_LIBRARY_PATH)}`,
    `harness_wrapper=$(type -P ${shellQuote(resolution.wrapperName)} || :)`,
    "harness_binary=",
    `if ! yolo_resolve_real_bin harness_binary ${shellQuote(resolution.executableName)} "${overrideValue}" "$harness_wrapper"; then`,
    `  echo ${shellQuote(`throne launch: no real '${resolution.executableName}' binary found on PATH`)} >&2`,
    "  exit 127",
    "fi",
  ];
}

function harnessLaunchCommand(launch: LaunchContext): string {
  const executable =
    launch.binaryResolution === undefined
      ? shellQuote(launch.argv[0] ?? "")
      : '"$harness_binary"';
  return `exec ${[executable, ...launch.argv.slice(1).map(shellQuote)].join(
    " ",
  )}`;
}

export function launchScriptText(
  launch: LaunchContext,
  stagedArtifactPaths: readonly string[],
): string {
  const environment = Object.entries(launch.env ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return [
    "#!/usr/bin/env bash",
    "set -e",
    ...environment,
    ...harnessLifetimeCleanupScript(stagedArtifactPaths),
    ...harnessBinaryResolutionScript(launch.binaryResolution),
    harnessLaunchCommand(launch),
    "",
  ].join("\n");
}

export function spawnerOwnsStagedArtifacts(launchIssued: boolean): boolean {
  return !launchIssued;
}

export function removeStagedArtifacts(
  stagedArtifactPaths: readonly string[],
): void {
  for (const stagedArtifactPath of stagedArtifactPaths) {
    rmSync(stagedArtifactPath, { recursive: true, force: true });
  }
}

export async function waitForDetectedAgentInPane(
  paneId: string,
  expectedKind: SupportedComposerHarness,
  deps: Pick<StartInTabDeps, "runHerdr" | "now" | "sleep">,
  timeoutMs: number = AGENT_DETECTION_TIMEOUT_MS,
): Promise<HerdrAgent> {
  const deadline = deps.now() + timeoutMs;
  let lastFailure: unknown;
  for (;;) {
    try {
      const { stdout } = await deps.runHerdr(["agent", "list"]);
      const detected = parseAgentList(stdout).find(
        (agent) => agent.paneId === paneId && agent.agent === expectedKind,
      );
      if (detected !== undefined) {
        return detected;
      }
    } catch (error) {
      lastFailure = error;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new AgentDetectionTimeoutError(
        paneId,
        expectedKind,
        timeoutMs,
        lastFailure,
      );
    }
    await deps.sleep(Math.min(AGENT_DETECTION_POLL_MS, remaining));
  }
}

export const REAL_START_IN_TAB_DEPS: StartInTabDeps = {
  runHerdr,
  now: Date.now,
  sleep,
};

export function isIndeterminateAgentStartError(error: unknown): boolean {
  return (
    (error instanceof HerdrCommandError && error.code === "timeout") ||
    error instanceof HarnessLaunchIssuedError
  );
}
