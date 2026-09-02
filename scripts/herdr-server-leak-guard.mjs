import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listLiveHerdrFixtureServers,
  listListeningUnixSockets,
  resolveProtectedCourtPids,
  SsUnavailableError,
} from "./herdr-fixture-server-reap.mjs";

// This guard measures the run's own herdr fixture-server socket population
// across the `npm test` invocation and, like `herdr-tab-leak-guard.mjs`, can
// be contaminated by a genuinely concurrent suite run whose own fixture
// server's before/after window overlaps this run's — see that file's
// docstring for the full reasoning; this guard accepts the same limitation
// and does not attempt to solve cross-suite concurrency.

// Keyed on THRONE_SUITE_RUN_ID so two concurrent suite runs never clobber
// each other's pretest/posttest snapshot file on the shared tmp filesystem.
// Falls back to a fixed name for a direct, non-containerized invocation
// (`npm run test:isolated` run standalone outside `run-suite-container.mjs`,
// which is where THRONE_SUITE_RUN_ID is set).
const SNAPSHOT_PATH = path.join(
  tmpdir(),
  `throne-herdr-server-leak-guard-snapshot-${process.env.THRONE_SUITE_RUN_ID ?? "standalone"}.json`,
);

/**
 * Filters the court's protected config-socket holder pid(s) out of a raw
 * server list. Applied BEFORE any before/after diffing, so a bug in the
 * diff logic can never be the thing that first notices or reports on the
 * court's own live server — the protected server never enters either
 * snapshot to begin with.
 */
export function excludeProtectedServers(servers, protectedPids) {
  return servers.filter((server) => !protectedPids.has(server.pid));
}

/**
 * Residue is defined as "present after this run but absent from this run's
 * own before-snapshot," keyed on socket path ALONE — never pid. A fixture
 * server's pid can be reused across that same server's own restart within
 * one suite session (the OS recycles pids), so two different servers that
 * are the same session could share a pid across the before/after window;
 * the socket path is the stable identity for a given session and is this
 * guard's equivalent of `findResidualTabs`'s tab-ID keying.
 */
export function findResidualServers(beforeSnapshot, afterSnapshot) {
  const beforeSocketPaths = new Set(
    beforeSnapshot.map((server) => server.socketPath),
  );
  return afterSnapshot.filter(
    (server) => !beforeSocketPaths.has(server.socketPath),
  );
}

async function snapshotLiveFixtureServers() {
  const listeningSockets = listListeningUnixSockets();
  const configHome = process.env.XDG_CONFIG_HOME ?? "";
  const protectedPids = resolveProtectedCourtPids(listeningSockets, configHome);
  const servers = listLiveHerdrFixtureServers(listeningSockets);
  return excludeProtectedServers(servers, protectedPids).map((server) => ({
    socketPath: server.socketPath,
    pid: server.pid,
    runId: server.runId,
  }));
}

async function writeSnapshot(snapshot) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot), "utf8");
}

async function readSnapshot() {
  return JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
}

function describeResidualServer(server) {
  return `${server.socketPath} (pid: ${server.pid}, runId: ${server.runId})`;
}

/**
 * `ss` not existing in the current environment (e.g. a minimal test
 * container image) is an environment-capability gap, not a leak — this
 * guard is a belt-and-suspenders check layered on top of the reaper's own
 * fail-loud CLI (which a human invokes and which correctly throws when `ss`
 * is genuinely required and absent). Crashing every `npm test` run in an
 * environment lacking `ss` would make the guard itself the outage; instead
 * it warns once, per mode, and lets the suite proceed unguarded for that run.
 */
function warnSsUnavailable(mode) {
  console.error(
    `herdr-server-leak-guard: skipping ${mode} — \`ss\` is not available in ` +
      "this environment, so this guard cannot verify the fixture-server " +
      "population here. This does not affect the reaper CLI itself, which " +
      "still requires and fails loudly without `ss` when a human invokes it.",
  );
}

async function runPretest() {
  let snapshot;
  try {
    snapshot = await snapshotLiveFixtureServers();
  } catch (error) {
    if (error instanceof SsUnavailableError) {
      warnSsUnavailable("pretest");
      return;
    }
    throw error;
  }
  await writeSnapshot(snapshot);
}

async function runPosttest() {
  let before;
  try {
    before = await readSnapshot();
  } catch (error) {
    if (error.code === "ENOENT") {
      // No pretest snapshot exists — either `ss` was unavailable at
      // pretest (already warned there) or posttest ran standalone without a
      // preceding pretest. Either way there is nothing to diff against.
      warnSsUnavailable("posttest (no pretest snapshot found)");
      return;
    }
    throw error;
  }

  let after;
  try {
    after = await snapshotLiveFixtureServers();
  } catch (error) {
    if (error instanceof SsUnavailableError) {
      await rm(SNAPSHOT_PATH, { force: true });
      warnSsUnavailable("posttest");
      return;
    }
    throw error;
  }
  await rm(SNAPSHOT_PATH, { force: true });

  const residualServers = findResidualServers(before, after);
  if (residualServers.length === 0) {
    return;
  }
  console.error(
    `herdr-server-leak-guard: ${residualServers.length} herdr fixture server(s) leaked by this test run:\n` +
      residualServers
        .map(describeResidualServer)
        .map((line) => `  - ${line}`)
        .join("\n"),
  );
  process.exitCode = 1;
}

const isDirectlyExecuted = import.meta.url === `file://${process.argv[1]}`;
if (isDirectlyExecuted) {
  const mode = process.argv[2];
  if (mode === "pretest") {
    await runPretest();
  } else if (mode === "posttest") {
    await runPosttest();
  } else {
    console.error(
      `herdr-server-leak-guard: unknown mode "${mode}" — expected "pretest" or "posttest"`,
    );
    process.exitCode = 1;
  }
}
