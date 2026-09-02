import path from 'node:path';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { realIdentity } from '../git-lifecycle/git-worktree.service.ts';
import type { ReapDeps, ReapRequest } from './reap-agent.types.ts';

function liveAgentName(agent: HerdrAgent): string | undefined {
  return agent.tabLabel ?? agent.name;
}

/** Compares REAL filesystem identity, not path strings — this box symlinks
 *  `/home` -> `/var/home`, so an agent's recorded cwd and the worktree path
 *  resolved elsewhere can spell the same directory two different ways. A
 *  bare string comparison silently misses that occupant. `realIdentity`
 *  (shared with `treeNameFromPath`) resolves symlinks and falls back to the
 *  unresolved path only when the target doesn't exist on disk. */
function isWithinTree(cwd: string, treePath: string): boolean {
  const resolvedCwd = realIdentity(cwd);
  const resolvedTree = realIdentity(treePath);
  return (
    resolvedCwd === resolvedTree ||
    resolvedCwd.startsWith(resolvedTree + path.sep)
  );
}

/**
 * Live agents whose recorded `cwd` lies inside `treePath` — INCLUDING
 * agents nested arbitrarily deep under it — EXCLUDING `name` itself (a
 * worktree's own agent occupying its own tree is normal, not a defect).
 *
 * Unlike `discoverChildAgents` (`./children.ts`), this asks nothing about
 * supervisor/child registration at all: a probe/canary spawned with `--cwd`
 * borrowed from an unrelated agent's tree has no parent/child relationship
 * to `name` whatsoever, which is exactly why the parentage check missed the
 * real incident this guard exists for (`agent-mqs06-canary-1uf` inside
 * `shadow-mgn-03`'s worktree, reaped out from under it).
 */
export function findTreeOccupants(
  name: string,
  treePath: string,
  agents: HerdrAgent[],
): HerdrAgent[] {
  return agents.filter((agent) => {
    const agentName = liveAgentName(agent);
    if (agentName !== undefined && sameAgentName(agentName, name)) {
      return false;
    }
    // An occupant with no name and no tab label never completed
    // create-agent's identity registration — it cannot be the agent being
    // reaped (that one is always named) or any other addressable agent, so
    // it can never be "cleared or relocated" by a human or by any command
    // that resolves agents by name. Blocking on it would refuse every reap
    // of this tree forever; excluding it here is what lets the escape hatch
    // in `refuseForOccupiedTree` warn about it instead of refusing on it.
    if (agentName === undefined) return false;
    if (agent.cwd === undefined || agent.cwd.length === 0) return false;
    return isWithinTree(agent.cwd, treePath);
  });
}

/** Live agents inside `treePath` that never completed identity registration
 *  (no name, no tab label) — throne can launch a harness process into a
 *  worktree without that process ever picking up a registered identity
 *  (e.g. a reconciliation pass that adopts a still-starting pane loses the
 *  race and leaves the earlier attempt's process running unnamed). These
 *  are reported, never silently dropped, but must not be able to block
 *  `reap-agent` indefinitely the way a real occupant does. */
export function findUnregisteredTreeOccupants(
  treePath: string,
  agents: HerdrAgent[],
): HerdrAgent[] {
  return agents.filter((agent) => {
    if (liveAgentName(agent) !== undefined) return false;
    if (agent.cwd === undefined || agent.cwd.length === 0) return false;
    return isWithinTree(agent.cwd, treePath);
  });
}

/** The on-disk worktree path `name` owns, or `undefined` when it has none
 *  (no recorded tree-repo provenance, or no matching worktree registered). */
export async function resolveWorktreePath(
  name: string,
  deps: ReapDeps,
): Promise<string | undefined> {
  const repo = await deps.readTreeRepo?.(name);
  const worktrees = await (deps.listWorktreesInRepo ?? (async () => []))(
    repo,
  );
  return worktrees.find((worktree) => worktree.branch === name)?.path;
}

function occupantLines(occupants: HerdrAgent[]): string[] {
  return occupants.map((agent) => {
    const occupantName = liveAgentName(agent) ?? '(unnamed live agent)';
    return `  - ${occupantName} (${agent.agentStatus}) cwd=${agent.cwd} — ` +
      `./bin/throne-cli reap-agent ${occupantName} --reason cancelled --force`;
  });
}

function unregisteredOccupantLines(occupants: HerdrAgent[]): string[] {
  return occupants.map(
    (agent) =>
      `  - unnamed ${agent.agent} process (${agent.agentStatus}) pane=${agent.paneId} ` +
      `cwd=${agent.cwd} — has no registered identity to address by name; end the process ` +
      `directly in its pane`,
  );
}

/**
 * The OCCUPANCY guard: refuses (or, under `--force`, loudly warns but still
 * proceeds) when ANY live agent other than `request.name` itself has a
 * recorded `cwd` inside the worktree `request.name` is about to have
 * removed. This is deliberately independent of `refuseForLiveChildren` — it
 * catches exactly the case that guard cannot: no supervisor/child
 * relationship, just a bare `cwd` overlap.
 *
 * Returns `true` when the caller must refuse (mirrors `refuseForLiveChildren`
 * and `refuseUnprovenLiveAgent`'s boolean-refusal convention in this module).
 */
export async function refuseForOccupiedTree(
  request: ReapRequest,
  agents: HerdrAgent[],
  deps: ReapDeps,
): Promise<boolean> {
  let treePath: string | undefined;
  try {
    treePath = await resolveWorktreePath(request.name, deps);
  } catch (error) {
    process.stderr.write(
      `reap-agent: cannot resolve the worktree path for "${request.name}" while ` +
        `checking live occupancy (${errorText(error)}) — refusing teardown.\n`,
    );
    return true;
  }
  if (treePath === undefined) return false;
  const unregistered = findUnregisteredTreeOccupants(treePath, agents);
  if (unregistered.length > 0) {
    process.stderr.write(
      `reap-agent: "${request.name}"'s worktree at "${treePath}" also holds ` +
        `${unregistered.length} unregistered live process(es) that never completed ` +
        `identity registration — proceeding past them, but they will need manual ` +
        `cleanup (they cannot be addressed by name):\n` +
        `${unregisteredOccupantLines(unregistered).join('\n')}\n`,
    );
  }
  const occupants = findTreeOccupants(request.name, treePath, agents);
  if (occupants.length === 0) return false;
  const lines = occupantLines(occupants);
  if (request.force) {
    process.stderr.write(
      `reap-agent: WARNING — removing "${request.name}"'s worktree at "${treePath}" ` +
        `while LIVE agent(s) still occupy it (not children of "${request.name}" — a bare ` +
        `cwd overlap, e.g. a probe/canary spawned with a borrowed --cwd):\n` +
        `${lines.join('\n')}\n` +
        `${'--force'} is proceeding anyway; those agents will hold a working directory ` +
        `that no longer exists and will need manual recovery ` +
        `(reap-agent <name> --reason cancelled --force).\n`,
    );
    return false;
  }
  process.stderr.write(
    `reap-agent: refusing to reap "${request.name}" — its worktree at "${treePath}" is ` +
      `still occupied by LIVE agent(s) that are not its children (a bare cwd overlap, ` +
      `e.g. a probe/canary spawned with a borrowed --cwd):\n${lines.join('\n')}\n` +
      `Clear or relocate the occupant(s) first, or re-run with --force to proceed anyway ` +
      `(this will orphan them — every tool call they make will fail at path resolution).\n`,
  );
  return true;
}
