import { spawn } from "node:child_process";
import { SUITE_CONTAINER_PLATFORM, containerRuntime } from "./container-runtime.mjs";

// Measured 2026-08-19 with:
//   podman build --no-cache -f docker/suite-app.Dockerfile -t <tag> .
// on a loaded host (load average ~16.45 on 12 cores): a real cold build
// (npm ci + npm run build, no layer cache) took 182750ms wall-clock. The
// previous flat 55000ms constant was less than a third of that and fired on
// live campaigns even under LOW host load. The default below is the
// measured duration doubled, which survives both the measured run and
// further contention headroom without requiring an operator override for
// the common case.
const DEFAULT_SUITE_BUILD_TIMEOUT_MS = 365_500;

const SUITE_BUILD_TIMEOUT_MS_ENV_VAR = "THRONE_SUITE_BUILD_TIMEOUT_MS";

export function resolveSuiteBuildTimeoutMs(env) {
  const override = env[SUITE_BUILD_TIMEOUT_MS_ENV_VAR];
  if (override === undefined) return DEFAULT_SUITE_BUILD_TIMEOUT_MS;
  const overrideMs = Number(override);
  if (!Number.isInteger(overrideMs) || overrideMs <= 0) {
    throw new Error(
      `${SUITE_BUILD_TIMEOUT_MS_ENV_VAR} must be a positive integer number of milliseconds, got ${JSON.stringify(override)}`,
    );
  }
  return overrideMs;
}

export class SuiteBuildTimeoutError extends Error {
  constructor(imageReference, timeoutMs) {
    super(
      `run-suite-container: container image build timed out for ${imageReference} after ${timeoutMs}ms`,
    );
    this.name = "SuiteBuildTimeoutError";
  }
}

export function runOwnedBuildProcess(
  command,
  args,
  imageReference,
  { timeoutMs = resolveSuiteBuildTimeoutMs(process.env), ...options } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true });
    let timedOut = false;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") settle(reject, error);
      }
    }, timeoutMs);
    child.once("error", (error) => settle(reject, error));
    child.once("close", (status) => {
      if (timedOut) {
        settle(reject, new SuiteBuildTimeoutError(imageReference, timeoutMs));
      } else if (status === 0) {
        settle(resolve);
      } else {
        settle(
          reject,
          new Error(
            `run-suite-container: ${command} build failed for ${imageReference} (exit ${status})`,
          ),
        );
      }
    });
  });
}

export function buildBoundedSuiteAppImage(
  imageReference,
  dockerfile,
  context,
  options,
  runtime = containerRuntime(),
) {
  return runOwnedBuildProcess(
    runtime,
    ["build", "--platform", SUITE_CONTAINER_PLATFORM, "-f", dockerfile, "-t", imageReference, context],
    imageReference,
    { stdio: "inherit", ...options },
  );
}
