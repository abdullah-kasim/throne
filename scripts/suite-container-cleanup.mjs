#!/usr/bin/env node
// Safe cleanup for orphaned throne-suite-app containers.
//
// ============================================================================
// ABSOLUTE FENCE (verbatim from the suiteleak queue item — do not weaken):
// never run this script or its tests against the live container set. Never
// kill, stop, prune, or 'podman rm' any real container, network, or image.
// All tests must use synthetic, clearly-labeled fixtures with mocked/
// injected podman & ps calls only. If you believe you must touch a live
// container to prove something, STOP and escalate instead.
// ============================================================================
//
// This script removes ONLY containers with no live owning run. A container
// is a removal candidate only when ALL THREE independent signals agree it
// is dead:
//   1. Its name matches the suite container naming pattern (already
//      required to be considered a candidate at all).
//   2. No live host process's command line still references that
//      container's compose project name or run id (cross-checked against
//      the kernel via `ps`, the same verification shape
//      scripts/suite-concurrency-guard-refusal.mjs's `isHolderVerified`
//      uses — never trust metadata alone).
//   3. The container is older than the age floor (default 60 minutes),
//      kept as an independent belt-and-suspenders floor even though signal
//      2 alone should suffice.
//
// Any container failing to definitively match all three is left alone.
//
// Removal, when it happens, is scoped to exactly that one container's
// compose project via `podman compose -p <project> down --volumes` — never
// a broad `podman rm`, never `podman system prune`, never touching a
// network or image outside that one project.
//
// Usage:
//   node scripts/suite-container-cleanup.mjs
//   node scripts/suite-container-cleanup.mjs --dry-run
//     Prints what WOULD be removed and why, without removing anything.
//     This is the default posture — run with no arguments first, always.
//   node scripts/suite-container-cleanup.mjs --apply
//     Actually removes the containers verdicted REMOVE.
//   node scripts/suite-container-cleanup.mjs --apply --container <name>
//     Scopes classification and removal to exactly the named container.
//   node scripts/suite-container-cleanup.mjs --apply --max-entries <n>
//     Bounds how many REMOVE-verdict containers this run will act on before
//     stopping and reporting what was and was not processed.
//   node scripts/suite-container-cleanup.mjs --help
//     Prints this usage and exits without removing anything.
//
// Any argument outside {--help, -h, --apply, --dry-run, --container <name>,
// --max-entries/--budget <n>} is a hard refusal: nonzero exit, zero
// removals, a message stating why the invocation was refused, naming the
// bypass, and naming the human route.
//
// An apply run writes the full classified candidate list to a JSON manifest
// on disk before removing anything, marking each entry complete as it is
// removed — so an interrupted run's boundary is auditable from the manifest.
// A SIGTERM during an apply run finishes the in-flight container removal,
// then stops before starting the next one and prints a processed/remaining
// summary; it never kills mid-removal and never silently keeps going.
//
// Structured output is one line per considered container: name, age,
// verdict, and reason, so a human/Regent can audit the decision before
// trusting it.
import { spawnSync } from "node:child_process";
import { containerRuntime, listContainersMatchingName } from "./container-runtime.mjs";
import {
  DEFAULT_MANIFEST_PATH,
  markManifestEntryComplete,
  writeResumableManifest,
} from "./suite-container-cleanup-manifest.mjs";
import { parseCliArgs, printUsage } from "./suite-container-cleanup-args.mjs";

export { parseCliArgs } from "./suite-container-cleanup-args.mjs";

// Either the run container itself (`throne-suite-app-<runId>`, named by
// run-suite-container.mjs) or a compose-era service container under that
// project name (`<project>-<service>-<n>`).
export const SUITE_CONTAINER_NAME_PATTERN =
  /^(throne-suite-app-[0-9a-fA-F]+)(?:[-_][a-zA-Z0-9]+[-_]\d+)?$/;

export const DEFAULT_AGE_FLOOR_MS = 60 * 60 * 1000;

/**
 * Pure discrimination function. Never shells out; every input is already
 * resolved data so this is directly unit-testable against synthetic
 * fixtures.
 *
 * @param {Array<{name: string, startedAt: string}>} containers
 * @param {{
 *   liveRunReferences: Set<string> | string[],
 *   now: number,
 *   ageFloorMs?: number,
 * }} options
 * @returns {Array<{
 *   name: string,
 *   projectName: string | null,
 *   ageMs: number | null,
 *   verdict: "REMOVE" | "KEEP",
 *   reason: string,
 * }>}
 */
export function classifySuiteContainers(
  containers,
  { liveRunReferences, now, ageFloorMs = DEFAULT_AGE_FLOOR_MS },
) {
  const liveRefs =
    liveRunReferences instanceof Set
      ? liveRunReferences
      : new Set(liveRunReferences ?? []);

  return containers.map((container) => {
    const match = SUITE_CONTAINER_NAME_PATTERN.exec(container.name);
    if (!match) {
      return {
        name: container.name,
        projectName: null,
        ageMs: null,
        verdict: "KEEP",
        reason: "name does not match the suite container naming pattern",
      };
    }
    const projectName = match[1];

    // Signal 2: no live host process may still reference this container's
    // project name OR its bare run id (the suffix after the last hyphen of
    // the project name) — a process might invoke podman compose against
    // the run id alone rather than the fully-qualified project string.
    const runId = projectName.slice(projectName.lastIndexOf("-") + 1);
    const hasLiveOwner = liveRefs.has(projectName) || liveRefs.has(runId);
    if (hasLiveOwner) {
      return {
        name: container.name,
        projectName,
        ageMs: null,
        verdict: "KEEP",
        reason: `a live host process still references project "${projectName}"`,
      };
    }

    // Signal 3: age floor.
    const started = Date.parse(container.startedAt ?? "");
    if (Number.isNaN(started)) {
      return {
        name: container.name,
        projectName,
        ageMs: null,
        verdict: "KEEP",
        reason: "container start time could not be determined",
      };
    }
    const ageMs = now - started;
    if (ageMs < ageFloorMs) {
      return {
        name: container.name,
        projectName,
        ageMs,
        verdict: "KEEP",
        reason: `younger than the ${Math.round(ageFloorMs / 60000)}m age floor`,
      };
    }

    return {
      name: container.name,
      projectName,
      ageMs,
      verdict: "REMOVE",
      reason:
        "matches suite naming pattern, no live owning process, past the age floor",
    };
  });
}

/**
 * Executable basenames of podman's own container-runtime supervisor
 * processes. Every running container has one of these attached by
 * construction (confirmed live: `/usr/bin/conmon -n <container-name> ...`,
 * `catatonit -P`), so a process from this class referencing a container's
 * project name is not evidence of a genuine external owner — it is the
 * container observing itself.
 */
const CONTAINER_RUNTIME_SUPERVISOR_PROCESS_NAMES = new Set([
  "conmon",
  "catatonit",
]);

function isContainerRuntimeSupervisorProcessLine(line) {
  const executablePath = line.trimStart().split(" ", 1)[0];
  const executableName = executablePath.split("/").pop();
  return CONTAINER_RUNTIME_SUPERVISOR_PROCESS_NAMES.has(executableName);
}

/**
 * Signal 2's data source: every host process still alive whose argv
 * references a suite compose project or run id. Reuses `ps -eo` +
 * substring scan on argv, the same kernel cross-check shape
 * `isHolderVerified` uses — never trust recorded metadata alone. Lines
 * belonging to podman's own container-runtime supervisor are excluded
 * before the scan: every running container is referenced by its own
 * supervisor by construction, so counting that as a live owner is
 * circular and would keep every running container forever.
 */
export function listLiveSuiteRunReferences(dependencies = { spawnSync }) {
  const result = dependencies.spawnSync("ps", ["-eo", "args"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `suite-container-cleanup: \`ps -eo args\` failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  const lines = result.stdout.split("\n");
  const references = new Set();
  for (const line of lines) {
    if (isContainerRuntimeSupervisorProcessLine(line)) continue;
    const matches = line.matchAll(/throne-suite-app-[0-9a-fA-F]+/g);
    for (const [reference] of matches) {
      references.add(reference);
    }
  }
  return references;
}

/**
 * Lists candidate containers via `<runtime> ps -a --format json`, restricted
 * up front to names matching the suite pattern so unrelated containers are
 * never even considered. The runtime (docker or podman) and the two
 * runtimes' different JSON shapes are bridged in container-runtime.mjs —
 * the same seam `suite-container-leak-guard.mjs` lists through — which
 * sources `startedAt` from podman's numeric `StartedAt` or docker's
 * absolute `CreatedAt` text.
 */
export function listSuiteContainers(dependencies = { spawnSync }) {
  return listContainersMatchingName(
    containerRuntime(),
    "throne-suite-",
    dependencies.spawnSync,
  );
}

/**
 * Effect: removes exactly one suite project — the named run container by
 * `rm --force` when the project IS that container, else (compose-era
 * service containers) that one compose project. Never a broader `rm`,
 * never a `system prune`.
 *
 * ATOMIC-UNDER-KILL: NOT ATOMIC. `compose down --volumes` is a single
 * subprocess call, but that subprocess itself performs multiple sequential
 * steps (stop container, remove container, remove network, remove
 * volumes). A kill delivered mid-call can leave any prefix of those steps
 * done and the rest undone — e.g. the container stopped and removed but
 * its network still present. This has not been measured against a live
 * kill; it is a bounded claim from compose's own documented multi-step
 * teardown, not an invented guarantee. A caller that needs a clean stop
 * boundary must stop BETWEEN calls to this function (finish the in-flight
 * call, then stop before starting the next), never assume a kill mid-call
 * leaves a well-defined state.
 */
export function removeSuiteContainerProject(
  projectName,
  dependencies = { spawnSync },
  runtime = containerRuntime(),
) {
  const runContainer = dependencies.spawnSync(
    runtime,
    ["rm", "--force", projectName],
    { stdio: "inherit" },
  );
  if (runContainer.status === 0) return;
  const down = dependencies.spawnSync(
    runtime,
    ["compose", "-p", projectName, "down", "--volumes"],
    { stdio: "inherit" },
  );
  if (down.status !== 0) {
    throw new Error(
      `suite-container-cleanup: ${runtime} rm and compose down both failed for project "${projectName}" (exit ${down.status})`,
    );
  }
}

function formatAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return "unknown";
  const minutes = Math.round(ageMs / 60000);
  return `${minutes}m`;
}

function formatLine(entry) {
  return `${entry.name}\tage=${formatAge(entry.ageMs)}\tverdict=${entry.verdict}\treason=${entry.reason}`;
}

function printStopSummary(reason, removedProjectNames, remainingProjectNames) {
  process.stdout.write(
    `suite-container-cleanup: stopped early (${reason}) — processed ${removedProjectNames.length} [${removedProjectNames.join(", ")}], ${remainingProjectNames.length} remaining [${remainingProjectNames.join(", ")}]\n`,
  );
}

export function runCleanup({
  dryRun,
  containerFilter = null,
  maxEntries = null,
  manifestPath = DEFAULT_MANIFEST_PATH,
  shouldStop = () => false,
  dependencies = {
    listSuiteContainers,
    listLiveSuiteRunReferences,
    removeSuiteContainerProject,
  },
  now = Date.now(),
} = {}) {
  const allContainers = dependencies.listSuiteContainers();
  const containers =
    containerFilter === null
      ? allContainers
      : allContainers.filter((container) => container.name === containerFilter);
  if (containerFilter !== null && containers.length === 0) {
    process.stdout.write(
      `suite-container-cleanup: container "${containerFilter}" is not present — nothing to do\n`,
    );
  }
  const liveRunReferences = dependencies.listLiveSuiteRunReferences();
  const decisions = classifySuiteContainers(containers, {
    liveRunReferences,
    now,
  });

  const removeVerdicts = decisions.filter((entry) => entry.verdict === "REMOVE");
  const manifestEntries = dryRun
    ? []
    : writeResumableManifest(decisions, manifestPath);

  const removedProjects = new Set();
  for (const entry of decisions) {
    process.stdout.write(`${formatLine(entry)}\n`);
    if (entry.verdict !== "REMOVE") continue;
    if (removedProjects.has(entry.projectName)) continue;
    if (dryRun) continue;

    const remainingProjects = removeVerdicts
      .map((remove) => remove.projectName)
      .filter(
        (projectName) =>
          !removedProjects.has(projectName) && projectName !== entry.projectName,
      );
    if (maxEntries !== null && removedProjects.size >= maxEntries) {
      printStopSummary(
        "max-entries budget reached",
        [...removedProjects],
        [entry.projectName, ...remainingProjects],
      );
      break;
    }
    if (shouldStop()) {
      printStopSummary(
        "SIGTERM received",
        [...removedProjects],
        [entry.projectName, ...remainingProjects],
      );
      break;
    }

    dependencies.removeSuiteContainerProject(entry.projectName);
    removedProjects.add(entry.projectName);
    markManifestEntryComplete(manifestEntries, entry.projectName, manifestPath);
  }
  return decisions;
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));

  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.mode === "help") {
    printUsage();
    return;
  }

  const dryRun = parsed.mode === "dry-run";
  if (dryRun) {
    process.stdout.write(
      "suite-container-cleanup: dry run — nothing will be removed (pass --apply to remove)\n",
    );
  }

  let stopRequested = false;
  process.on("SIGTERM", () => {
    stopRequested = true;
  });

  runCleanup({
    dryRun,
    containerFilter: parsed.containerFilter,
    maxEntries: parsed.maxEntries,
    shouldStop: () => stopRequested,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
