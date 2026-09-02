// Teardown effect for one REMOVE-verdict candidate from
// `herdr-fixture-server-reap.mjs`. Split into its own file per this repo's
// 500-line hand-authored file limit — discovery/classification stays in the
// reaper's own file (orchestration + pure predicates); this file owns only
// the teardown effect and its signal-safety guard.
import {
  HERDR_SUITE_SESSION_NAME_PREFIX,
  teardownHerdrSuiteSessionByName,
} from "./herdr-suite-session.mjs";
import {
  isFixtureServerSocketPath,
  listListeningUnixSockets,
  resolveProtectedCourtPids,
} from "./herdr-fixture-server-reap.mjs";

/**
 * Pure. Strips the known suite-session socket suffix
 * (`/herdr/sessions/<prefix><runId>/herdr.sock`) from a candidate's own
 * `socketPath` to recover the `XDG_CONFIG_HOME` that candidate's session
 * actually lives under. Each candidate's session was launched under ITS OWN
 * config home, almost never the reap operator's own — the herdr client CLI
 * looks in the wrong place and silently fails to reach the session unless
 * this derived value is used instead of the operator's ambient env.
 * Returns `undefined` if `socketPath` doesn't have that shape (defensive:
 * discovery already only produces candidates matching the pattern, but this
 * function never assumes its caller did that correctly).
 *
 * @param {string} socketPath
 * @param {string} runId
 * @returns {string | undefined}
 */
export function deriveConfigHomeFromCandidateSocketPath(socketPath, runId) {
  const suffix = `/herdr/sessions/${HERDR_SUITE_SESSION_NAME_PREFIX}${runId}/herdr.sock`;
  if (!socketPath.endsWith(suffix)) return undefined;
  return socketPath.slice(0, -suffix.length);
}

/**
 * True when `pid` is still alive and signalable. `process.kill(pid, 0)`
 * sends no signal, only probes: it throws `ESRCH` when the process is gone
 * (dead), throws `EPERM` when it exists but this process can't signal it
 * (treated as alive — a permission failure is not evidence of death), and
 * returns normally when it exists and is signalable.
 */
export function isPidAlive(pid, dependencies = { kill: process.kill.bind(process) }) {
  try {
    dependencies.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const SIGNAL_FALLBACK_POLL_INTERVAL_MS = 200;
// ~3s total bound for SIGTERM to take effect before escalating to SIGKILL —
// short and explicit, never a busy-loop, never an indefinite wait.
const SIGNAL_FALLBACK_POLL_ATTEMPTS = 15;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * STRUCTURAL GUARD, load-bearing for the kill decision itself, not merely
 * for which env var gets passed to the herdr CLI: re-derives, from the
 * CURRENT live socket table (never cached classification state), whether
 * `candidate.pid` is still SAFE TO SIGNAL right now. Both the court's real
 * server and every leaked fixture server report as `herdr server` in `ps`,
 * so this never consults process name or binary path — only the live
 * socket enumeration `herdr-fixture-server-reap.mjs` already uses for
 * discovery. Returns `false` (never eligible) unless BOTH hold at this
 * instant:
 *   (a) the pid still holds a listening socket matching the fixture-server
 *       pattern (re-checked via `isFixtureServerSocketPath`, the same
 *       predicate discovery uses — not re-derived by hand), and
 *   (b) the pid is not the freshly-resolved court protected pid.
 * This makes it structurally impossible for the signal fallback to reach
 * the court's pid: even if `candidate` were somehow stale or forged with
 * the court's pid, this function only signals a pid this instant's own
 * socket enumeration shows holding a `/herdr/sessions/throne-suite-*`
 * socket — which the court's real sockets (`herdr.sock`,
 * `herdr-client.sock`) never match by construction — AND that same
 * enumeration's own protected-pid resolution excludes independently, in
 * addition to (not instead of) the pre-classification exclusion in
 * `runReap`.
 */
function resolveSignalEligiblePid(candidate, { listListeningUnixSockets: listSockets, configHome }) {
  const liveSockets = listSockets();
  const protectedPids = resolveProtectedCourtPids(liveSockets, configHome);
  if (protectedPids.has(candidate.pid)) return false;
  return liveSockets.some(
    (socket) => socket.pid === candidate.pid && isFixtureServerSocketPath(socket.socketPath),
  );
}

/**
 * Effect: sends `candidate.pid` a bounded SIGTERM-then-SIGKILL sequence and
 * returns whether the pid is confirmed dead afterward. Used only as a
 * fallback when the herdr-session path above did not actually kill the
 * process (an unreachable-via-session dangling socket, or any other silent
 * failure of that path) — never called before the protected-pid/run-id
 * classification gate has already verdicted the candidate REMOVE, and never
 * called without `resolveSignalEligiblePid` re-confirming eligibility from
 * live evidence immediately beforehand.
 */
async function terminateCandidateBySignal(
  candidate,
  {
    kill = process.kill.bind(process),
    sleep = defaultSleep,
    pollIntervalMs = SIGNAL_FALLBACK_POLL_INTERVAL_MS,
    pollAttempts = SIGNAL_FALLBACK_POLL_ATTEMPTS,
  } = {},
) {
  kill(candidate.pid, "SIGTERM");
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    if (!isPidAlive(candidate.pid, { kill })) return true;
  }
  kill(candidate.pid, "SIGKILL");
  await sleep(pollIntervalMs);
  return !isPidAlive(candidate.pid, { kill });
}

/**
 * Effect: tears down one REMOVE-verdict candidate. Reuses
 * `herdr-suite-session.mjs`'s existing stop-then-delete effects as the
 * first attempt (never a new termination mechanism for that path), built
 * with the CANDIDATE's own derived `XDG_CONFIG_HOME` rather than the reap
 * operator's ambient env. That helper swallows its own subprocess errors
 * (correct for its other callers), so success is never assumed from its
 * return alone — this function verifies via pid liveness afterward. When
 * the candidate is still alive (either the herdr-session path failed
 * silently, or its session directory is already gone and unreachable via
 * the herdr CLI at all), falls back to a direct, bounded SIGTERM→SIGKILL.
 *
 * SIGNAL SAFETY: immediately before any signal is sent, `dependencies`'s
 * `listListeningUnixSockets`/`configHome` are used to re-verify eligibility
 * from the current live process table (`resolveSignalEligiblePid`) — never
 * on cached classification state. If that re-verification fails, this
 * function refuses to signal the pid at all and reports a failed teardown;
 * it never falls through to signaling on a stale assumption.
 *
 * ATOMIC-UNDER-KILL, both paths:
 * - herdr-session path: NOT atomic. A kill between `server stop` and
 *   `session delete` leaves a stopped-but-registered session record. That
 *   is a knowable, recoverable partial state, not data loss and not a
 *   double-kill risk: the stopped server no longer holds a listening
 *   socket, so the NEXT run of this reaper's discovery step will not see
 *   it as a live fixture server at all (discovery is socket-path-based)
 *   — it simply will not be re-classified. The residual
 *   `session delete`-pending record is left for herdr's own session
 *   bookkeeping/`session list` to observe and is not this reaper's concern
 *   to double-clean.
 * - signal fallback path: each `kill()` call is a single syscall, so a kill
 *   of THIS reaper process between sending SIGTERM and observing the poll
 *   result leaves the target either already dead (if SIGTERM alone was
 *   enough) or still alive and simply un-signalled a second time — safe: a
 *   still-listening socket makes it a candidate again on the next reaper
 *   run, which will re-discover and re-attempt it.
 *
 * @returns {Promise<{succeeded: boolean, method: "herdr-session" | "signal" | "failed"}>}
 */
export async function teardownHerdrFixtureServer(candidate, dependencies = {}) {
  const {
    env = process.env,
    teardownSession = teardownHerdrSuiteSessionByName,
    kill = process.kill.bind(process),
    sleep = defaultSleep,
    pollIntervalMs,
    pollAttempts,
    listListeningUnixSockets: listCurrentListeningUnixSockets = listListeningUnixSockets,
    configHome = process.env.XDG_CONFIG_HOME ?? "",
  } = dependencies;

  const sessionName = `${HERDR_SUITE_SESSION_NAME_PREFIX}${candidate.runId}`;
  const derivedConfigHome = deriveConfigHomeFromCandidateSocketPath(
    candidate.socketPath,
    candidate.runId,
  );
  const sessionEnv =
    derivedConfigHome === undefined ? env : { ...env, XDG_CONFIG_HOME: derivedConfigHome };

  await teardownSession(sessionName, sessionEnv);
  if (!isPidAlive(candidate.pid, { kill })) {
    return { succeeded: true, method: "herdr-session" };
  }

  if (
    !resolveSignalEligiblePid(candidate, {
      listListeningUnixSockets: listCurrentListeningUnixSockets,
      configHome,
    })
  ) {
    return { succeeded: false, method: "failed" };
  }

  const signalSucceeded = await terminateCandidateBySignal(candidate, {
    kill,
    sleep,
    pollIntervalMs,
    pollAttempts,
  });
  return { succeeded: signalSucceeded, method: signalSucceeded ? "signal" : "failed" };
}
