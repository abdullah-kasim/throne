#!/usr/bin/env node
// run's own container genuinely tore down.
//
// Same family as scripts/dist-staleness-guard.mjs and
// scripts/herdr-tab-leak-guard.mjs: a fail-loud guard, not a silent cleanup.
// Unlike those two (whole-court before/after snapshot diffs run from a
// separate pretest/posttest invocation), this one checks THIS run's own
// outcome from inside the same process that ran it — see
// 000_current_questions.md Q1/Q2 for why a snapshot diff from a different
// process can't catch a hard-killed parent skipping its own `finally`.
import { containerRuntime, listContainersMatchingName } from "./container-runtime.mjs";

/**
 * Pure predicate: given normalized `ps --format json` rows (see
 * container-runtime.mjs `normalizeContainerRow`)
 * for containers matching this run's compose project, decide whether any of
 * them still exist after `cleanup.run()` settled. There is no "live owning
 * run" filter here — this checks THIS run's own outcome, not the whole
 * court's container set, so any container carrying this run's project name
 * after teardown is by definition leaked (assert only, never a second
 * teardown attempt from inside the guard).
 *
 *   invocation) to this run's suite key.
 */
export function findLeakedSuiteContainers(containers) {
  return { leaked: containers.filter((container) => container != null) };
}

/**
 * Every container whose name carries this run's suite key — the seam
 * `verifySuiteRunTornDown` shells out through, via the same runtime the
 * rest of run-suite-container.mjs uses (docker or podman; see
 * container-runtime.mjs for the `ps --format json` shape bridging).
 */
export function listContainersForSuiteProject(
  suiteKey,
  runtime = containerRuntime(),
) {
  return listContainersMatchingName(runtime, `throne-suite-app-${suiteKey}`);
}

/**
 * Runs after `cleanup.run()` settles inside `runComposedSuite`'s own
 * `finally` block: verifies this run's container genuinely tore down.
 *
 * @param {string} runId
 * @param {string} suiteKey resolved by the caller.
 */
export function verifySuiteRunTornDown(
  runId,
  suiteKey,
  { listContainers = listContainersForSuiteProject } = {},
) {
  const containers = listContainers(suiteKey);
  const { leaked } = findLeakedSuiteContainers(containers);
  if (leaked.length === 0) return;
  const names = leaked
    .map((container) => container.name || "<unknown>")
    .join(", ");
  throw new Error(
    `run-suite-container: leaked container(s) for run ${runId} still present after cleanup: ${names}`,
  );
}
