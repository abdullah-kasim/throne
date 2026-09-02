#!/usr/bin/env node
// Reaper for leaked herdr fixture servers — the fifth litter population
// (`herdrfixture`, distinct from `podmanlitter`'s podman artefacts,
// `litterbomb`'s filesystem-scratch/compile-cache sweeps, and
// `reaporphanproc`'s orphaned agent processes; none of those are touched
// here).
//
// ============================================================================
// ABSOLUTE FENCE: candidates are identified ONLY by listening socket path,
// never by process name or binary path. Both the court's real server (the
// linuxbrew `herdr` binary, sole holder of `~/.config/herdr/herdr.sock` and
// `herdr-client.sock`) and every leaked fixture server (the throne-managed
// binary under `/tmp/throne-herdr-*`) report as `herdr server` in `ps` — a
// reaper matching on name or binary path kills the court. The court's
// protected socket holder pid(s) are resolved FIRST, independently, and
// placed in a never-touch set BEFORE any candidate is classified — mirrors
// `src/procwatch/never-touch.ts`'s seed-first-classify-second ordering.
// ============================================================================
//
// Reap eligibility is run-id liveness, NEVER age, NEVER the fixture server's
// own presence: a candidate REMOVEs only when no OTHER live host process
// still references its run id. The server's own argv/socket path trivially
// references its own run id — that is not evidence the suite run is live,
// it's the exact circularity `cleanupcircular` (86e566f) already fixed for
// containers, mirrored here via `isFixtureServerOwnProcessLine`.
//
// Usage:
//   node scripts/herdr-fixture-server-reap.mjs [--dry-run]
//     Prints per-candidate discovery + verdict + reason. Nothing is torn
//     down. This is the default even with no arguments.
//   node scripts/herdr-fixture-server-reap.mjs --apply
//     Tears down every REMOVE-verdict candidate.
//   node scripts/herdr-fixture-server-reap.mjs --help
//     Prints usage, exits 0, touches nothing.
import { spawnSync } from "node:child_process";

import {
  HERDR_SUITE_SESSION_NAME_PREFIX,
  resolveHerdrSuiteSocketPath,
} from "./herdr-suite-session.mjs";
import { teardownHerdrFixtureServer } from "./herdr-fixture-server-teardown.mjs";

const USAGE = `herdr-fixture-server-reap: reap leaked herdr fixture servers

Usage:
  node scripts/herdr-fixture-server-reap.mjs [--dry-run]   classify only (default)
  node scripts/herdr-fixture-server-reap.mjs --apply       tear down REMOVE-verdict candidates
  node scripts/herdr-fixture-server-reap.mjs --help        show this message

Candidates are discovered by listening socket path only (never process name).
The court's own config-socket holder is always excluded. Reap eligibility is
run-id liveness (a live host process other than the candidate itself still
referencing the run id), never age.
`;

// Matches this repo's suite-session socket layout:
//   <configHome>/herdr/sessions/throne-suite-<runid>/herdr.sock
const FIXTURE_SERVER_SOCKET_PATTERN = new RegExp(
  `/herdr/sessions/(${HERDR_SUITE_SESSION_NAME_PREFIX}([^/]+))/herdr\\.sock$`,
);

/**
 * Pure. True when `socketPath` matches the suite-session fixture-server
 * pattern. Exported so `herdr-fixture-server-teardown.mjs`'s pre-signal
 * safety re-check reuses this exact predicate rather than re-deriving the
 * pattern by hand.
 */
export function isFixtureServerSocketPath(socketPath) {
  return FIXTURE_SERVER_SOCKET_PATTERN.test(socketPath);
}

/**
 * Pure. Given every live listening unix socket + holder pid, returns the
 * subset whose socket path matches the suite-session pattern, with the run
 * id already extracted. Never consults process name/binary path — a
 * fixture server and the court's real server both report as `herdr server`
 * in `ps`, so name-based discovery is unsafe by construction.
 *
 * @param {Array<{socketPath: string, pid: number}>} listeningSockets
 * @returns {Array<{socketPath: string, pid: number, runId: string}>}
 */
export function listLiveHerdrFixtureServers(listeningSockets) {
  const candidates = [];
  for (const socket of listeningSockets) {
    const match = FIXTURE_SERVER_SOCKET_PATTERN.exec(socket.socketPath);
    if (!match) continue;
    candidates.push({
      socketPath: socket.socketPath,
      pid: socket.pid,
      runId: match[2],
    });
  }
  return candidates;
}

/**
 * Pure. Resolves the court's own protected socket holder pid(s) — the
 * pid(s) holding `<configHome>/herdr/herdr.sock` and
 * `<configHome>/herdr/herdr-client.sock` — by socket path, independently of
 * the fixture-server pattern above. Called and its result seeded into the
 * never-touch set BEFORE any candidate is classified; every classification
 * path checks this set unconditionally, even though the fixture-server
 * pattern structurally never matches these paths (defense in depth, not
 * implied by non-overlap, per the slice's explicit requirement).
 *
 * @param {Array<{socketPath: string, pid: number}>} listeningSockets
 * @param {string} configHome
 * @returns {Set<number>}
 */
export function resolveProtectedCourtPids(listeningSockets, configHome) {
  const protectedPaths = new Set([
    `${configHome}/herdr/herdr.sock`,
    `${configHome}/herdr/herdr-client.sock`,
  ]);
  const pids = new Set();
  for (const socket of listeningSockets) {
    if (protectedPaths.has(socket.socketPath)) {
      pids.add(socket.pid);
    }
  }
  return pids;
}

/**
 * True when a `ps -eo pid,args` line is a candidate fixture server's own
 * process — its pid matches AND its argv references its own run id. Such a
 * line must be excluded before scanning for "is this run id live" evidence:
 * a fixture server's own argv/socket path trivially contains its own run
 * id, and counting that as proof of liveness is the exact
 * server-observing-itself circularity `cleanupcircular` (86e566f) already
 * fixed for containers via `isContainerRuntimeSupervisorProcessLine`.
 */
function isFixtureServerOwnProcessLine(line, candidatePid) {
  const trimmed = line.trimStart();
  const spaceIndex = trimmed.indexOf(" ");
  const pidToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  return Number(pidToken) === candidatePid;
}

/**
 * Pure. Given `ps -eo pid,args` output lines and the set of candidate pids
 * (excluded from the scan as their own process), returns the set of run ids
 * referenced by any OTHER live host process. Mirrors
 * `suite-container-cleanup.mjs`'s `listLiveSuiteRunReferences` shape.
 *
 * @param {string[]} psLines
 * @param {Set<number>} candidatePids
 * @returns {Set<string>}
 */
export function listLiveSuiteRunProcessReferences(psLines, candidatePids) {
  const references = new Set();
  for (const line of psLines) {
    const trimmed = line.trimStart();
    const spaceIndex = trimmed.indexOf(" ");
    const pidToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const linePid = Number(pidToken);
    if (candidatePids.has(linePid) && isFixtureServerOwnProcessLine(line, linePid)) {
      continue;
    }
    const matches = trimmed.matchAll(
      new RegExp(`${HERDR_SUITE_SESSION_NAME_PREFIX}([A-Za-z0-9-]+)`, "g"),
    );
    for (const [, runId] of matches) {
      references.add(runId);
    }
  }
  return references;
}

/**
 * Pure discrimination function — deny-by-default. A candidate can only
 * REMOVE when it is provably not the court's server AND provably has no
 * live owner. Anything the inputs cannot resolve verdicts UNKNOWN, never
 * REMOVE, mirroring `litterbomb`'s (56846ea8) deny-by-default shape.
 *
 * @param {Array<{socketPath: string, pid: number, runId: string}>} candidates
 * @param {Set<number>} protectedPids
 * @param {Set<string>} liveRunIdReferences
 * @returns {Array<{socketPath: string, pid: number, runId: string, verdict: "REMOVE"|"KEEP"|"UNKNOWN", reason: string}>}
 */
export function classifyHerdrFixtureServers(
  candidates,
  protectedPids,
  liveRunIdReferences,
) {
  return candidates.map((candidate) => {
    if (protectedPids.has(candidate.pid)) {
      return {
        ...candidate,
        verdict: "KEEP",
        reason: "pid is the court's own protected config-socket holder",
      };
    }
    if (!candidate.runId) {
      return {
        ...candidate,
        verdict: "UNKNOWN",
        reason: "socket path matched but no run id could be extracted",
      };
    }
    if (liveRunIdReferences.has(candidate.runId)) {
      return {
        ...candidate,
        verdict: "KEEP",
        reason: `a live host process other than this server still references run id "${candidate.runId}"`,
      };
    }
    return {
      ...candidate,
      verdict: "REMOVE",
      reason:
        "matches the suite-session socket pattern, is not the court's protected pid, and no other live process references its run id",
    };
  });
}

function formatLine(entry) {
  return `${entry.socketPath}\tpid=${entry.pid}\trunId=${entry.runId ?? "unknown"}\tverdict=${entry.verdict}\treason=${entry.reason}`;
}

/**
 * Discovery dependency: enumerates live listening unix sockets and their
 * holder pid, equivalent to `ss -xlp` output. Never `ps` process
 * name/binary path, never a directory listing alone — sockets can outlive
 * their own session directory (the queue item's own measurement).
 *
 * `ss -xlp` unix-socket LISTEN lines look like:
 *   u_str LISTEN 0 4096 /path/to/herdr.sock 12345 * 0 users:(("herdr",pid=6789,fd=8))
 * The local-address column is the socket path; the holder pid comes from
 * the `pid=NNNN` token in the process column, not the inode-adjacent number
 * that precedes it.
 */
/**
 * Thrown when the `ss` binary itself could not be launched (e.g. it is not
 * installed in the current environment) — distinct from `ss` launching and
 * reporting a nonzero exit. Callers that can only run where `ss` exists (the
 * reaper CLI, invoked by a human) let this propagate and fail loud, exactly
 * like any other unresolvable-enumeration case. Callers that must survive an
 * environment without `ss` (the leak guard, wired into every `npm test` run
 * including containers that may not ship it) catch this specific code and
 * degrade instead of aborting the whole suite.
 */
export class SsUnavailableError extends Error {
  constructor(cause) {
    super(`herdr-fixture-server-reap: \`ss\` binary is not available: ${cause}`);
    this.code = "SS_UNAVAILABLE";
  }
}

export function listListeningUnixSockets(dependencies = { spawnSync }) {
  const result = dependencies.spawnSync("ss", ["-xlp"], { encoding: "utf8" });
  if (result.error) {
    throw new SsUnavailableError(result.error.message ?? result.error);
  }
  if (result.status !== 0) {
    throw new Error(
      `herdr-fixture-server-reap: \`ss -xlp\` failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  const sockets = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("u_") || !line.includes("LISTEN")) continue;
    const pidMatch = /pid=(\d+)/.exec(line);
    if (!pidMatch) continue;
    const pathMatch = /(\/\S+\.sock)/.exec(line);
    if (!pathMatch) continue;
    sockets.push({ socketPath: pathMatch[1], pid: Number(pidMatch[1]) });
  }
  return sockets;
}

/** Discovery dependency: `ps -eo pid,args` lines, one per live host process. */
export function listProcessLines(dependencies = { spawnSync }) {
  const result = dependencies.spawnSync("ps", ["-eo", "pid,args"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `herdr-fixture-server-reap: \`ps -eo pid,args\` failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.split("\n").slice(1); // drop the header row
}

export async function runReap({
  apply,
  configHome = process.env.XDG_CONFIG_HOME ?? "",
  dependencies = {
    listListeningUnixSockets,
    listProcessLines,
    teardownHerdrFixtureServer,
  },
} = {}) {
  const listeningSockets = dependencies.listListeningUnixSockets();
  const protectedPids = resolveProtectedCourtPids(listeningSockets, configHome);
  const candidates = listLiveHerdrFixtureServers(listeningSockets);
  const candidatePids = new Set(candidates.map((candidate) => candidate.pid));
  const processLines = dependencies.listProcessLines();
  const liveRunIdReferences = listLiveSuiteRunProcessReferences(
    processLines,
    candidatePids,
  );
  const decisions = classifyHerdrFixtureServers(
    candidates,
    protectedPids,
    liveRunIdReferences,
  );

  for (const entry of decisions) {
    process.stdout.write(`${formatLine(entry)}\n`);
  }
  if (apply) {
    for (const entry of decisions) {
      if (entry.verdict !== "REMOVE") continue;
      entry.teardown = await dependencies.teardownHerdrFixtureServer(entry, {
        listListeningUnixSockets: dependencies.listListeningUnixSockets,
        configHome,
      });
      process.stdout.write(
        `${entry.socketPath}\tpid=${entry.pid}\tteardown=${entry.teardown.succeeded ? "succeeded" : "FAILED"}\tmethod=${entry.teardown.method}\n`,
      );
    }
  }
  return decisions;
}

const ALLOWED_ARGS = new Set(["--dry-run", "--apply", "--help", "-h"]);

/**
 * Fail-closed CLI parser. Any token outside the allowlist refuses: nonzero
 * exit, zero side effects, and a three-part refusal (WHY / bypass / human
 * route) matching AGENTS.md's command-entry steering contract. There is no
 * bypass flag for this tool — refusal says so plainly and still names the
 * supervisor route, per that contract's "when no bypass exists" clause.
 */
export function parseCliArgs(argv) {
  for (const token of argv) {
    if (!ALLOWED_ARGS.has(token)) {
      return {
        error:
          `herdr-fixture-server-reap: refusing unrecognised argument ${JSON.stringify(token)}. ` +
          `WHY: only ${[...ALLOWED_ARGS].join(", ")} are accepted, to keep this tool fail-closed. ` +
          `BYPASS: none — no flag waives argument validation for this tool. ` +
          `HUMAN ROUTE: ask your supervisor which invocation was intended.`,
      };
    }
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    return { mode: "help" };
  }
  if (argv.includes("--apply")) {
    return { mode: "apply" };
  }
  return { mode: "dry-run" };
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  if (parsed.mode === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.mode === "dry-run") {
    process.stdout.write(
      "herdr-fixture-server-reap: --dry-run — nothing will be torn down\n",
    );
  }
  await runReap({ apply: parsed.mode === "apply" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { resolveHerdrSuiteSocketPath };
