#!/usr/bin/env node
// container path (docker or podman — see container-runtime.mjs; set
// THRONE_CONTAINER_RUNTIME to force one). Composes the Herdr session seam and the tmpfs concurrency
// guard exactly as shipped; it does not reimplement either.
//
//   node --import ./test/register-typescript.mjs scripts/run-suite-container.mjs \
//     <runId> -- <suite command...>
//
// The `--import` is required because herdr-suite-session.mjs transitively
// imports decorated `.ts` sources (herdr-update-session.ts and its own
// dependency chain). package.json's `test` script supplies it at the public
// entrypoint, and the guarded re-exec below supplies it again for the child.
//
// This script's own body (buildSuite, below) is the thing
// suite-concurrency-guard.mjs execs once a tmpfs slot is free: on the
// outer/CLI invocation this process re-execs itself through the guard,
// wrapping everything below in the guard's held-slot lifetime, then the
// wrapped re-invocation (marked --slot-held) does the actual work. No
// separate slot-acquisition logic lives here — see main() below.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERDR_DECOUPLE_FEATURE_FLAG_NAME,
} from "../src/herdr/herdr-client.ts";
import { buildBoundedSuiteAppImage } from "./suite-owned-build.mjs";
import {
  SUITE_CONTAINER_PLATFORM,
  containerImageExists,
  containerRunUserArguments,
  containerRuntime,
} from "./container-runtime.mjs";
import { verifySuiteRunTornDown } from "./suite-container-leak-guard.mjs";
import {
  ZERO_TESTS_EXECUTED_EXIT_CODE,
  countTestsExecuted,
  formatTestsExecutedLine,
  suiteExitedCleanWithoutRunningTests,
} from "./suite-test-verdict.mjs";
import { applyTenSecondLawGate } from "./suite-duration-gate.mjs";
import {
  SuiteSignalError,
  findSuiteSignal,
  runChildWithSignalForwarding,
} from "./suite-child-signal-forwarding.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const APP_DOCKERFILE = path.join(HERE, "..", "docker", "suite-app.Dockerfile");
const SUITE_APP_IMAGE_NAME = "localhost/throne-suite-app";

// Confirmation task (not a redesign): THRONE_LIVE_ROOT is already
// parameterised (src/throne-root-resolution.ts resolves it with
// `path.resolve(overrideRoot)` against the CURRENT process's cwd, never an
// absolute host path baked in anywhere upstream) so the existing relative
// fixture path is exactly as hermetic inside the container's own filesystem
// view as it is on the host — nothing here needs to invent a container-only
// mechanism. See the execution log for the direct evidence run.
const DEFAULT_THRONE_LIVE_ROOT = "./test/fixtures/empty-live-root";

// A linked worktree's `.git` file points at host-owned history that is neither
// valid nor intended inside the hermetic suite image. The image build creates
// its own disposable repository instead, so this runner never resolves or
// exposes host git state.

export function resolveSuiteRunPaths(runId, hostHome = os.homedir()) {
  const scratchParent = path.join(hostHome, "tmp");
  mkdirSync(scratchParent, { recursive: true });
  const runRoot = mkdtempSync(
    path.join(scratchParent, `throne-suite-${runId}-`),
  );
  const home = path.join(runRoot, "home");
  const dataHome = path.join(runRoot, "throne");
  const xdgDataHome = path.join(runRoot, "xdg-data");
  const worktreesHome = path.join(runRoot, "worktrees");
  const configHome = mkdtempSync(path.join(hostHome, "tmp", "throne-herdr-"));
  for (const directory of [
    home,
    path.join(home, "tmp"),
    dataHome,
    xdgDataHome,
    worktreesHome,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  const throneConfigHome = path.join(configHome, "throne");
  mkdirSync(throneConfigHome, { recursive: true });
  writeFileSync(
    path.join(throneConfigHome, "features.json"),
    `${JSON.stringify({ [HERDR_DECOUPLE_FEATURE_FLAG_NAME]: true })}\n`,
    "utf8",
  );
  return {
    runRoot,
    home,
    dataHome,
    xdgDataHome,
    worktreesHome,
    configHome,
  };
}

export function createSuiteRunId() {
  return randomBytes(8).toString("hex");
}

export function resolveSuiteAppImageReference(runId) {
  return `${SUITE_APP_IMAGE_NAME}:${runId}`;
}

export function buildSuiteAppImage(
  imageReference,
  dockerfile = APP_DOCKERFILE,
  context = REPO_ROOT,
  runtime = containerRuntime(),
) {
  const build = spawnSync(
    runtime,
    ["build", "--platform", SUITE_CONTAINER_PLATFORM, "-f", dockerfile, "-t", imageReference, context],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error(
      `run-suite-container: ${runtime} build failed for ${imageReference} from ${dockerfile} (exit ${build.status})`,
    );
  }
}

export function removeSuiteAppImage(imageReference, runtime = containerRuntime()) {
  if (!containerImageExists(runtime, imageReference)) return;
  const removal = spawnSync(
    runtime,
    ["image", "rm", "--force", imageReference],
    { stdio: "inherit" },
  );
  if (removal.status !== 0) {
    throw new Error(
      `run-suite-container: ${runtime} image removal failed for ${imageReference} (exit ${removal.status})`,
    );
  }
}

export function buildOwnedSuiteAppImage(
  cleanup,
  imageReference,
  build = buildSuiteAppImage,
) {
  cleanup.register("suite app image", () =>
    removeSuiteAppImage(imageReference),
  );
  build(imageReference);
}

export async function buildOwnedSuiteAppImageBounded(
  cleanup,
  imageReference,
  build = buildBoundedSuiteAppImage,
) {
  cleanup.register("suite app image", () =>
    removeSuiteAppImage(imageReference),
  );
  await build(imageReference, APP_DOCKERFILE, REPO_ROOT);
}

export function createCleanupStack() {
  const cleanups = [];
  let cleanupPromise;
  return {
    register(name, cleanup) {
      cleanups.push({ name, cleanup });
    },
    run(primaryFailure) {
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          const cleanupFailures = [];
          for (const { name, cleanup } of cleanups.reverse()) {
            try {
              await cleanup();
            } catch (error) {
              cleanupFailures.push(
                new Error(`cleanup "${name}" failed`, { cause: error }),
              );
            }
          }
          if (primaryFailure !== undefined && cleanupFailures.length > 0) {
            throw new AggregateError(
              [primaryFailure, ...cleanupFailures],
              "suite execution and owned cleanup both failed",
            );
          }
          if (primaryFailure !== undefined) throw primaryFailure;
          if (cleanupFailures.length > 0) {
            throw new AggregateError(
              cleanupFailures,
              "suite owned cleanup failed",
            );
          }
        })();
      }
      return cleanupPromise;
    },
  };
}

export function resolveSuiteContainerEnvironment(suitePaths, { sessionName, runId }) {
  return {
    ...process.env,
    HOME: suitePaths.home,
    XDG_CONFIG_HOME: suitePaths.configHome,
    XDG_DATA_HOME: suitePaths.xdgDataHome,
    THRONE_DATA_HOME: suitePaths.dataHome,
    THRONE_WORKTREES_HOME: suitePaths.worktreesHome,
    THRONE_HERDR_SESSION_NAME_OVERRIDE: sessionName,
    THRONE_LIVE_ROOT: process.env.THRONE_LIVE_ROOT || DEFAULT_THRONE_LIVE_ROOT,
    THRONE_SUITE_CONTAINERIZED: "1",
    THRONE_SUITE_RUN_ID: runId,
    THRONE_HERDR_CLIENT_PATH: "/usr/local/bin/herdr",
    // The host's TMPDIR must not leak in: macOS exports one under
    // /var/folders/..., which does not exist inside the image, and
    // os.tmpdir() honours it — the suite's first mkdtemp died on exactly
    // that (2026-09-02, docker on a mac). It is pinned to the container's
    // own /tmp, which is what a linux host gets by default and what the
    // suite's own tests assume: a bind-mounted path here is long enough to
    // push the herdr sockets tests create past the unix socket path limit,
    // and on Docker Desktop's shared filesystem it loses the executable
    // bit a permissions test depends on. Both measured, same day.
    TMPDIR: "/tmp",
    // Same class of leak: herdr spawns $SHELL for every pane, and a mac
    // host exports /opt/homebrew/bin/bash, which the image does not have.
    SHELL: "/bin/bash",
    PATH: "/usr/local/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

export function resolveSuiteConfigSeedPath(suitePaths) {
  return `${suitePaths.configHome}.seed`;
}

/**
 * Two run-scoped writable mounts: the run root (home, data, worktrees) as
 * a plain bind mount, and the config home as a CONTAINER tmpfs seeded from
 * the host's copy (mounted read-only beside it; see
 * `createSuiteContainerCommand` for the copy). The config home holds
 * herdr's session directory and its unix sockets, and herdr's server fails
 * with EINVAL when that directory sits on Docker Desktop's shared
 * filesystem on a mac (measured 2026-09-02: the isolated suite session
 * never reported running, while the same server on a tmpfs came up in
 * seconds). A tmpfs is right for it on every host: the session is
 * disposable per run and nothing on the host reads it back. `mode=1777`
 * because the tmpfs is root-owned and the suite runs as the host uid.
 */
export function createSuiteContainerMountArguments(suitePaths) {
  return [
    "--volume",
    `${suitePaths.runRoot}:${suitePaths.runRoot}`,
    "--volume",
    `${suitePaths.configHome}:${resolveSuiteConfigSeedPath(suitePaths)}:ro`,
    "--tmpfs",
    `${suitePaths.configHome}:mode=1777`,
  ];
}

/**
 * The container's argv: copy the read-only config seed into the tmpfs
 * config home, then exec the suite command. Paths travel as positional
 * parameters, never interpolated into the shell text.
 */
export function createSuiteContainerCommand(suitePaths, suiteArgv) {
  return [
    "sh",
    "-c",
    'cp -R "$1"/. "$2"/ && shift 2 && exec "$@"',
    "sh",
    resolveSuiteConfigSeedPath(suitePaths),
    suitePaths.configHome,
    ...suiteArgv,
  ];
}

export function resolveSuiteContainerName(runId) {
  return `throne-suite-app-${runId}`;
}

/**
 * The runtime-specific half of `run`'s argv, before mounts/env/image. The
 * container is NAMED after the run so the leak guard and
 * suite-container-cleanup.mjs can find it; an unnamed `--rm` container was
 * invisible to both, which made the teardown guard pass vacuously.
 */
export function createSuiteContainerRunArguments(
  runtime,
  runId,
  { uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0 } = {},
) {
  return [
    "run",
    "--rm",
    "--name",
    resolveSuiteContainerName(runId),
    "--platform",
    SUITE_CONTAINER_PLATFORM,
    // podman: `--userns=keep-id` keeps this container's process at the same
    // uid as the host; docker: `--user <uid>:<gid>` does the same job. The
    // tmpfs concurrency guard accounts quota by host uid, so neither runtime
    // may run the suite as a different uid.
    ...containerRunUserArguments(runtime, { uid, gid }),
    // `:z`/`:Z` SELinux relabeling was rejected: this box refuses to
    // relabel a directory the size of $HOME outright ("SELinux
    // relabeling of $HOME is not allowed" — verified live, see
    // execution log), and `:Z` specifically would relabel it
    // exclusively for ONE container, breaking a second concurrent
    // suite's own mount of the same $HOME mid-run — exactly the
    // cross-suite contamination this composition point exists to
    // prevent. `label=disable` scopes the exemption to this one
    // container's own SELinux confinement instead of touching the
    // host path's label at all, so concurrent mounts never contend.
    // docker accepts the same spelling and ignores it where SELinux is
    // absent.
    "--security-opt",
    "label=disable",
  ];
}

async function runComposedSuite(runId, suiteCommand) {
  const suitePaths = resolveSuiteRunPaths(runId);
  const imageReference = resolveSuiteAppImageReference(runId);
  const cleanup = createCleanupStack();
  cleanup.register("run namespaces", () => {
    rmSync(suitePaths.configHome, { recursive: true, force: true });
    rmSync(suitePaths.runRoot, { recursive: true, force: true });
  });
  let primaryFailure;
  try {
    await buildOwnedSuiteAppImageBounded(cleanup, imageReference);

    const suiteEnv = resolveSuiteContainerEnvironment(suitePaths, {
      sessionName: `throne-suite-${runId}`,
      runId,
    });
    const envArgs = Object.entries(suiteEnv).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    const mountArgs = createSuiteContainerMountArguments(suitePaths);

    const runtime = containerRuntime();
    process.stdout.write(
      `suite-run: id=${runId} runtime=${runtime} data=${suitePaths.dataHome} config=${suitePaths.configHome}\n`,
    );
    let suiteOutput = "";
    const suiteStartedAt = new Date();
    const status = await runChildWithSignalForwarding(
      runtime,
      [
        ...createSuiteContainerRunArguments(runtime, runId),
        ...mountArgs,
        ...envArgs,
        imageReference,
        ...createSuiteContainerCommand(suitePaths, [
          "node",
          "--import",
          "./test/register-typescript.mjs",
          "./scripts/herdr-suite-session.mjs",
          "run",
          runId,
          "--",
          ...suiteCommand,
        ]),
      ],
      { stdio: "inherit", onOutput: (chunk) => { suiteOutput += chunk; } },
    );
    const suiteFinishedAt = new Date();
    process.stdout.write(
      `suite-wall-clock: before=${suiteStartedAt.toISOString()} after=${suiteFinishedAt.toISOString()} elapsed_ms=${suiteFinishedAt.getTime() - suiteStartedAt.getTime()}\n`,
    );
    const executedCount = countTestsExecuted(suiteOutput);
    // Greppable on this script's own stdout for EVERY real run, not only the
    // zero-count failure case below — a gate Shadow (or a human) reading the
    // log can find "tests executed:" once and get the real count without
    // re-deriving it from the raw node --test TAP output.
    process.stdout.write(formatTestsExecutedLine(executedCount));
    if (suiteExitedCleanWithoutRunningTests(status, executedCount)) {
      process.stderr.write(
        executedCount === undefined
          ? "run-suite-container: suite exited 0 but no test-runner \"tests N\" summary was found in its output — refusing to report success for a run whose test count cannot be confirmed\n"
          : "run-suite-container: suite exited 0 but executed zero tests — refusing to report success; check the test globs actually matched files\n",
      );
      return ZERO_TESTS_EXECUTED_EXIT_CODE;
    }
    return applyTenSecondLawGate(status, suiteOutput, {
      isHeavyTier: Boolean(process.env.THRONE_HEAVY_TESTS),
      writeViolation: (line) => process.stderr.write(line),
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    let cleanupFailure;
    try {
      await cleanup.run(primaryFailure);
    } catch (error) {
      cleanupFailure = error;
    }
    verifySuiteRunTornDown(runId, runId);
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
}

function reexecUnderConcurrencySlot(runId, suiteCommand) {
  const guardScript = path.join(HERE, "suite-concurrency-guard.mjs");
  const selfScript = fileURLToPath(import.meta.url);
  const registerTypescript = path.join(
    REPO_ROOT,
    "test",
    "register-typescript.mjs",
  );
  const result = spawnSync(
    "node",
    [
      guardScript,
      "node",
      "--import",
      registerTypescript,
      selfScript,
      "--slot-held",
      runId,
      "--",
      ...suiteCommand,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) {
    throw new Error(
      `run-suite-container: could not invoke suite-concurrency-guard.mjs (${result.error.message})`,
    );
  }
  return result.status ?? 1;
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    throw new Error(
      "usage: run-suite-container.mjs [--slot-held] [runId] -- <suite command...>",
    );
  }
  const slotHeld = argv[0] === "--slot-held";
  const idIndex = slotHeld ? 1 : 0;
  if (separatorIndex - idIndex > 1) {
    throw new Error(
      "usage: run-suite-container.mjs [--slot-held] [runId] -- <suite command...>",
    );
  }
  const suppliedRunId =
    separatorIndex === idIndex + 1 ? argv[idIndex] : undefined;
  const runId = suppliedRunId || createSuiteRunId();
  const suiteCommand = argv.slice(separatorIndex + 1);
  if (suiteCommand.length === 0) {
    throw new Error("run-suite-container.mjs: <suite command...> is empty");
  }
  return { slotHeld, runId, suiteCommand };
}

async function main() {
  const { slotHeld, runId, suiteCommand } = parseArgs(process.argv.slice(2));
  if (!slotHeld) {
    process.exit(reexecUnderConcurrencySlot(runId, suiteCommand));
  }
  const exitCode = await runComposedSuite(runId, suiteCommand);
  process.exit(exitCode);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    const signal = findSuiteSignal(err);
    if (signal) process.kill(process.pid, signal);
    else process.exit(1);
  });
}

export { runComposedSuite };
