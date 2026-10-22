// Grants Claude Code's per-project trust for a throne worktree by writing
// directly into the config file of the account folder the agent launches on:
// `~/.claude.json` for the primary folder `~/.claude`, `<folder>/.claude.json`
// for any other account folder. Each account is ONE shared folder used by
// every agent on that account; there are no per-agent config folders.
//
// WHY THERE ARE NO PER-AGENT FOLDERS. Two claims, deliberately kept apart,
// because only one of them is established and the refusal rests on the
// established one:
//
//   MEASURED, and sufficient on its own: A PER-AGENT SEED MADE RECOVERY FROM
//   AN AUTH EXPIRY IMPOSSIBLE. A seed held a private copy of the credential,
//   so a re-authentication could not reach a live agent — the refreshed file
//   lands in the account's folder while the agent keeps reading its snapshot.
//   Observed repeatedly on 2026-08-15/16: agents wedged on `Login expired`
//   while a valid credential sat on disk, one holding a copy taken at 00:53
//   against a re-auth at 01:21. Whatever causes an expiry, the seed converted
//   a recoverable event into a wedged agent.
//
//   REPORTED BY THE ACCOUNT OWNER, NOT INDEPENDENTLY CONFIRMED: that several
//   config directories on one credential cause the account to expire logins
//   aggressively. Plausible, and consistent with seven seed directories being
//   live at once — but throne has no visibility into why a session expired,
//   and the observed expiries are equally consistent with ordinary expiry.
//
// Stated this way so that if the second claim is ever disproved, the refusal
// still stands on the first. A shared account folder holds one login that
// every agent on it reads, so a re-authentication reaches all of them.
//
// WHY THE WRITE IS UNAVOIDABLE. Claude Code gates its untrusted-folder modal
// on `projects.<absolute path>.hasTrustDialogAccepted`. It creates a project
// entry when it opens a directory but never sets that flag on its own: at the
// time of the 2026-08 change `~/.claude.json` held 151 project entries, 84 of
// them under the throne worktrees folder, and NONE of the 84 were trusted. So
// a spawn with no trust grant blocks on a modal nobody can see — a total court
// outage, not a degradation.

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";

/** Bounded so a crashed writer's stale lock cannot wedge every future spawn:
 *  the lock is held for one small read-modify-write, so exceeding this means
 *  something is wrong rather than merely slow. */
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

export interface ClaudeWorktreeTrustDeps {
  homedir: () => string;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  mkdirSync: typeof mkdirSync;
  rmdirSync: typeof rmdirSync;
  realpathSync: typeof realpathSync;
  sleepMs: (ms: number) => void;
}

/** Synchronous sleep. The launch path that needs this is synchronous, and a
 *  spin would burn a core while several agents spawn at once. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const REAL_CLAUDE_WORKTREE_TRUST_DEPS: ClaudeWorktreeTrustDeps = {
  homedir: os.homedir,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmdirSync,
  realpathSync,
  sleepMs,
};

export interface ClaudeConfigTarget {
  readonly configPath: string;
  readonly dismissesAutoModeNudge: boolean;
}

export function claudeConfigPath(deps: ClaudeWorktreeTrustDeps): string {
  return path.join(deps.homedir(), ".claude.json");
}

export function primaryClaudeConfigTarget(
  deps: ClaudeWorktreeTrustDeps = REAL_CLAUDE_WORKTREE_TRUST_DEPS,
): ClaudeConfigTarget {
  return { configPath: claudeConfigPath(deps), dismissesAutoModeNudge: false };
}

/** Resolves symlinks when the path exists, and returns it unchanged when it
 *  does not. A missing path is not an error here — it only means there is
 *  nothing to compare against yet — but a path that exists must be compared in
 *  its resolved form or `/home` vs `/var/home` splits one directory into two. */
function resolvedOrRaw(deps: ClaudeWorktreeTrustDeps, target: string): string {
  try {
    return deps.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * `mkdir` is atomic on every filesystem throne runs on, so an exclusively
 * created directory is a lock with no separate compare-and-set. Several
 * agents demonstrably spawn within seconds of each other, and the file being
 * guarded is the account's real config — a lost update here does not cost a
 * trust flag, it silently drops an unrelated key the human depends on.
 */
function withConfigLock<T>(
  deps: ClaudeWorktreeTrustDeps,
  configPath: string,
  body: () => T,
): T {
  const lockPath = `${configPath}.throne-lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      deps.mkdirSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      deps.sleepMs(LOCK_RETRY_MS);
      continue;
    }
    try {
      return body();
    } finally {
      try {
        deps.rmdirSync(lockPath);
      } catch {
        // Releasing a lock we hold should not mask the body's own outcome.
      }
    }
  }
  throw new Error(
    `claude worktree trust: could not acquire "${lockPath}" after ` +
      `${LOCK_ATTEMPTS} attempts. A previous writer may have died holding it; ` +
      `remove that directory once no throne spawn is in flight.`,
  );
}

function readConfigOrThrow(
  deps: ClaudeWorktreeTrustDeps,
  configPath: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = deps.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `claude worktree trust: cannot read "${configPath}" ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Refusing to launch: without a trust grant the agent blocks on an ` +
        `untrusted-folder modal that nobody can see.`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `claude worktree trust: "${configPath}" is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Refusing to launch rather than overwrite it.`,
    );
  }
}

/** Every project entry throne has any business trusting: the worktree being
 *  launched, plus any existing entry under the same worktrees root. Scoped
 *  deliberately — this writes to the human's real config, and silently
 *  trusting their unrelated personal projects is not throne's call to make. */
function throneOwnedProjectPaths(
  deps: ClaudeWorktreeTrustDeps,
  projects: Record<string, Record<string, unknown>>,
  worktreeRealPath: string,
): string[] {
  // RESOLVE THE ROOT, never compare raw. `homedir()` can report an
  // unresolved path while every project key Claude Code wrote is the resolved
  // one — on a host where the home directory's parent is a symlink, the two
  // spellings name one directory and a raw string prefix compare matches
  // NOTHING. The backfill then silently does nothing, in the safe-looking
  // direction: the worktree being launched is still granted trust, so nothing
  // appears broken. Same defect the standing realpath-equivalence order
  // exists to prevent. Caught only by running this against a copy of a real
  // config; fixtures with internally consistent paths cannot express it.
  const worktreesRoot = `${path.join(
    resolvedOrRaw(deps, resolveThroneHome(process.env, deps.homedir())),
    "worktrees",
  )}${path.sep}`;
  const owned = Object.keys(projects).filter((projectPath) =>
    projectPath.startsWith(worktreesRoot),
  );
  return owned.includes(worktreeRealPath) ? owned : [...owned, worktreeRealPath];
}

function needsAutoModeNudgeDismissed(
  config: Record<string, unknown>,
  target: ClaudeConfigTarget,
): boolean {
  return target.dismissesAutoModeNudge && config.hasSeenAutoDefaultNudge !== true;
}

/**
 * Ensures `worktreePath` (and every other throne worktree already present in
 * the config) is marked trusted in `target`, then returns whether anything
 * changed.
 *
 * Idempotent and lock-free on the common path: a spawn into an
 * already-trusted worktree reads, finds nothing to do, and returns without
 * taking the lock or rewriting the file. Only a genuine change serialises.
 */
export function grantThroneWorktreeTrust(
  worktreePath: string,
  deps: ClaudeWorktreeTrustDeps = REAL_CLAUDE_WORKTREE_TRUST_DEPS,
  target: ClaudeConfigTarget = primaryClaudeConfigTarget(deps),
): boolean {
  const worktreeRealPath = deps.realpathSync(worktreePath);
  const { configPath } = target;

  const untrustedPaths = (config: Record<string, unknown>): string[] => {
    const projects = (config.projects ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    return throneOwnedProjectPaths(deps, projects, worktreeRealPath).filter(
      (projectPath) => projects[projectPath]?.hasTrustDialogAccepted !== true,
    );
  };
  const needsWrite = (config: Record<string, unknown>): boolean =>
    untrustedPaths(config).length > 0 || needsAutoModeNudgeDismissed(config, target);

  if (!needsWrite(readConfigOrThrow(deps, configPath))) return false;

  return withConfigLock(deps, configPath, () => {
    // Re-read INSIDE the lock. The check above raced by construction, and
    // acting on the pre-lock snapshot would reintroduce the lost update the
    // lock exists to prevent.
    const config = readConfigOrThrow(deps, configPath);
    if (!needsWrite(config)) return false;

    const projects = (config.projects ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const projectPath of untrustedPaths(config)) {
      projects[projectPath] = {
        ...(projects[projectPath] ?? {}),
        hasTrustDialogAccepted: true,
      };
    }
    config.projects = projects;
    if (target.dismissesAutoModeNudge) config.hasSeenAutoDefaultNudge = true;

    // Write-then-rename: a crash mid-write leaves the original config intact
    // rather than a truncated one. Losing the human's real config is a far
    // worse outcome than any spawn failure.
    const temporaryPath = `${configPath}.throne-${process.pid}.tmp`;
    deps.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    deps.renameSync(temporaryPath, configPath);
    return true;
  });
}
