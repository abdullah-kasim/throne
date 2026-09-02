import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveThroneHerdrSessionName } from "../herdr/herdr-client.ts";

const execFileAsync = promisify(execFile);

/** The one session name this capability must never launch under, stop, or
 *  otherwise operate on — the live court. */
export const HERDR_UPDATE_LIVE_SESSION_NAME = "throne";

/** Resolves the rehearsal's target session name from the same env override
 *  slice-02 introduced, then refuses to proceed if it resolves to the live
 *  default — the rehearsal caller MUST set
 *  `THRONE_HERDR_SESSION_NAME_OVERRIDE` to an isolated name first. */
export function resolveIsolatedHerdrUpdateSessionName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = resolveThroneHerdrSessionName(env);
  if (name === HERDR_UPDATE_LIVE_SESSION_NAME) {
    throw new Error(
      `herdr-update refuses to rehearse against the live session name "${HERDR_UPDATE_LIVE_SESSION_NAME}"; ` +
        "set THRONE_HERDR_SESSION_NAME_OVERRIDE to an isolated test session name before running the rehearsal",
    );
  }
  return name;
}

export interface HerdrUpdateSessionHandle {
  readonly sessionName: string;
  readonly cleanup: () => Promise<void>;
}

async function writeNestedAllowScratchConfig(): Promise<{
  configPath: string;
  configDir: string;
}> {
  const configDir = await mkdtemp(
    path.join(os.tmpdir(), "herdr-update-config-"),
  );
  const configPath = path.join(configDir, "config.toml");
  // Runs inside an already-herdr-managed pane; herdr refuses nested launches
  // by default, so the rehearsal supplies a throwaway config (never the live
  // one at ~/.config/herdr/config.toml) opting in for this process only.
  await writeFile(configPath, "[experimental]\nallow_nested = true\n");
  return { configPath, configDir };
}

/** Launches a herdr server under an isolated session name and waits for it
 *  to report running. Never touches `herdr-server.service`, `throne-work.service`,
 *  or the live session — refuses up front if asked to. */
export async function launchIsolatedHerdrSession(
  executablePath: string,
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrUpdateSessionHandle> {
  if (sessionName === HERDR_UPDATE_LIVE_SESSION_NAME) {
    throw new Error(
      `herdr-update refuses to launch the live session name "${HERDR_UPDATE_LIVE_SESSION_NAME}"`,
    );
  }
  const { configPath, configDir } = await writeNestedAllowScratchConfig();
  const child = spawn(executablePath, ["--session", sessionName], {
    stdio: "ignore",
    detached: true,
    env: { ...env, HERDR_CONFIG_PATH: configPath },
  });
  child.unref();

  const cleanup = async (): Promise<void> => {
    await execFileAsync(
      executablePath,
      ["--session", sessionName, "server", "stop"],
      {
        env,
        timeout: 5_000,
      },
    ).catch(() => undefined);
    await execFileAsync(executablePath, ["session", "delete", sessionName], {
      env,
      timeout: 5_000,
    }).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  };

  try {
    await waitUntilIsolatedSessionRunning(executablePath, sessionName, env);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { sessionName, cleanup };
}

async function waitUntilIsolatedSessionRunning(
  executablePath: string,
  sessionName: string,
  env: NodeJS.ProcessEnv,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const status = await readIsolatedSessionStatus(
      executablePath,
      sessionName,
      env,
    );
    if (status.running) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `herdr-update: isolated session "${sessionName}" did not report running within ${timeoutMilliseconds}ms`,
  );
}

export interface HerdrUpdateStatus {
  readonly running: boolean;
  readonly version: string | null;
  readonly protocol: string | null;
}

/** Reads the isolated session's own live-reported status — the same shape
 *  `preflightCompatibility` parses for the real client. */
export async function readIsolatedSessionStatus(
  executablePath: string,
  sessionName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrUpdateStatus> {
  const { stdout } = await execFileAsync(
    executablePath,
    ["--session", sessionName, "status", "server", "--json"],
    { env },
  );
  const parsed = JSON.parse(stdout) as {
    running: boolean;
    version: string | number | null;
    protocol: string | number | null;
  };
  return {
    running: parsed.running === true,
    version: parsed.version === null ? null : String(parsed.version),
    protocol: parsed.protocol === null ? null : String(parsed.protocol),
  };
}

export interface HerdrUpdateSweepResult {
  readonly command: string;
  readonly succeeded: boolean;
  readonly output: string;
}

/** The read-only herdr-dependent throne command surface, per `HerdrClientService`
 *  and `attach-throne-herdr`: version probe, status probe, and a non-mutating
 *  `agent` read (never a command in `MUTATING_HERDR_COMMANDS`). */
const HERDR_UPDATE_COMMAND_SWEEP: readonly (readonly string[])[] = [
  ["--version"],
  ["status", "server", "--json"],
  ["agent", "list"],
];

/** Exercises the real read-only command sweep against the isolated session
 *  and records each outcome, success or failure, as evidence. */
export async function sweepHerdrDependentCommands(
  executablePath: string,
  sessionName: string,
): Promise<HerdrUpdateSweepResult[]> {
  const results: HerdrUpdateSweepResult[] = [];
  for (const args of HERDR_UPDATE_COMMAND_SWEEP) {
    try {
      const { stdout } = await execFileAsync(executablePath, [
        "--session",
        sessionName,
        ...args,
      ]);
      results.push({
        command: args.join(" "),
        succeeded: true,
        output: stdout.trim(),
      });
    } catch (error) {
      results.push({
        command: args.join(" "),
        succeeded: false,
        output: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
