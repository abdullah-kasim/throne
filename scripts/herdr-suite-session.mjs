import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  launchIsolatedHerdrSession,
  HERDR_UPDATE_LIVE_SESSION_NAME,
} from "../src/herdr-update/herdr-update-session.ts";
import { ownedHerdrClientPath } from "../src/herdr/herdr-client.ts";
import path from "node:path";



/** Every isolated suite session name carries this prefix so it is
 *  recognizable in `herdr session list` output and can never collide with
 *  the live court's `'throne'` session or a herdr-update rehearsal session. */
export const HERDR_SUITE_SESSION_NAME_PREFIX = "throne-suite-";
export const HERDR_SOCKET_PATH_CAPACITY_BYTES = 104;

/** Generates a fresh per-run isolated session name. Never returns
 *  `HERDR_UPDATE_LIVE_SESSION_NAME` — the prefix makes that structurally
 *  impossible. */
export function resolveHerdrSuiteSessionName(runId = randomUUID()) {
  return `${HERDR_SUITE_SESSION_NAME_PREFIX}${runId}`;
}

export function resolveHerdrSuiteSocketPath(configHome, sessionName) {
  return path.join(configHome, "herdr", "sessions", sessionName, "herdr.sock");
}

export function assertHerdrSuiteSocketPathFits(configHome, sessionName) {
  const socketPath = resolveHerdrSuiteSocketPath(configHome, sessionName);
  const encodedBytes = Buffer.byteLength(socketPath, "utf8") + 1;
  if (encodedBytes > HERDR_SOCKET_PATH_CAPACITY_BYTES) {
    throw new Error(
      `herdr-suite-session: socket path requires ${encodedBytes} UTF-8 bytes including NUL; capacity is ${HERDR_SOCKET_PATH_CAPACITY_BYTES}: ${socketPath}`,
    );
  }
  return {
    socketPath,
    encodedBytes,
    capacityBytes: HERDR_SOCKET_PATH_CAPACITY_BYTES,
  };
}

/**
 * Launches a fresh isolated herdr session for one suite run, reusing the
 * `launchIsolatedHerdrSession` pattern `herdr-update-session.ts` already
 * proves — this is the only session-selection seam this repo has; nothing
 * here duplicates `resolveThroneHerdrSessionName`/
 * `THRONE_HERDR_SESSION_NAME_OVERRIDE`, it only decides which value to hand
 * that seam.
 *
 * Returns the session name (set the caller's
 * `THRONE_HERDR_SESSION_NAME_OVERRIDE` to this value before running the
 * suite) and a `cleanup` that stops the session's server and deletes the
 * session, leaving no residual herdr server process or session artifact
 * behind whether the suite passed or failed.
 */
export async function launchHerdrSuiteSession(
  runId = randomUUID(),
  env = process.env,
) {
  const sessionName = resolveHerdrSuiteSessionName(runId);
  const configHome = env.XDG_CONFIG_HOME;
  if (!configHome) {
    throw new Error(
      "herdr-suite-session: XDG_CONFIG_HOME is required for an isolated suite session",
    );
  }
  assertHerdrSuiteSocketPathFits(configHome, sessionName);
  const handle = await launchIsolatedHerdrSession(
    ownedHerdrClientPath(env),
    sessionName,
    env,
  );
  return { sessionName: handle.sessionName, cleanup: handle.cleanup };
}

/**
 * Tears down a previously launched suite session by name — the same
 * stop-then-delete effects `launchIsolatedHerdrSession`'s own `cleanup`
 * closure performs, issued from a separate process that never held that
 * closure (shell-driven verification only spans process boundaries; the
 * real in-process caller, scripts/run-suite-container.mjs, holds and calls
 * `cleanup` directly and never needs this). Refuses any name outside the
 * suite-session prefix so
 * this can never be pointed at the live `'throne'` session by a typo.
 */
export async function teardownHerdrSuiteSessionByName(sessionName, env = process.env) {
  if (!sessionName?.startsWith(HERDR_SUITE_SESSION_NAME_PREFIX)) {
    throw new Error(
      `herdr-suite-session: refusing to tear down non-suite session name ${JSON.stringify(sessionName)}`,
    );
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const executablePath = ownedHerdrClientPath(env);
  await execFileAsync(
    executablePath,
    ["--session", sessionName, "server", "stop"],
    { env },
  ).catch(() => undefined);
  await execFileAsync(executablePath, ["session", "delete", sessionName], {
    env,
  }).catch(() => undefined);
}

export async function runSuiteInsideHerdrSession(runId, suiteCommand, env = process.env) {
  if (suiteCommand.length === 0) {
    throw new Error("herdr-suite-session: suite command is required");
  }
  const sessionHandle = await launchHerdrSuiteSession(runId, env);
  try {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(suiteCommand[0], suiteCommand.slice(1), {
        env: {
          ...env,
          THRONE_HERDR_SESSION_NAME_OVERRIDE: sessionHandle.sessionName,
        },
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) {
          reject(
            new Error(
              `herdr-suite-session: suite command exited from signal ${signal}`,
            ),
          );
          return;
        }
        resolve(code ?? 1);
      });
    });
    return status;
  } finally {
    await sessionHandle.cleanup();
  }
}

const isDirectlyExecuted = import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) {
  const mode = process.argv[2];
  if (mode === "launch") {
    // The server launched by `launchIsolatedHerdrSession` is spawned
    // detached and unref'd — it outlives this process by design, so this
    // command only needs to print the resolved name and exit.
    const { sessionName } = await launchHerdrSuiteSession(
      process.argv[3],
      process.env,
    );
    process.stdout.write(`${sessionName}\n`);
  } else if (mode === "teardown") {
    await teardownHerdrSuiteSessionByName(process.argv[3], process.env);
  } else if (mode === "run") {
    const separatorIndex = process.argv.indexOf("--", 4);
    if (separatorIndex === -1) {
      throw new Error(
        'herdr-suite-session: "run" requires -- before the suite command',
      );
    }
    process.exitCode = await runSuiteInsideHerdrSession(
      process.argv[3],
      process.argv.slice(separatorIndex + 1),
      process.env,
    );
  } else {
    throw new Error(
      `herdr-suite-session: unknown mode ${JSON.stringify(mode)} — expected "launch", "teardown", or "run"`,
    );
  }
}

export { HERDR_UPDATE_LIVE_SESSION_NAME };
