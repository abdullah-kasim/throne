import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { sleep } from "../herdr/herdr-screen.service.ts";

/**
 * Locally-owned outcome shape covering exactly the fields this module's own
 * `flagLiveCwdOrphans` produces. Declared here instead of importing the
 * parent module's broader outcome type to avoid recreating an import cycle
 * with `throne-startup-reconciliation.service.ts` (which imports this
 * module's `flagLiveCwdOrphans`). TypeScript's structural typing keeps every
 * existing call site compiling with zero changes: this interface's `action`
 * literal is a member of the parent's `StartupOrphanAction` union and
 * `ok: true` is assignable to `boolean`, so a `CwdGuardOutcome` is
 * assignable wherever the parent's outcome type is expected.
 */
interface CwdGuardOutcome {
  name: string;
  action: "flag-missing-cwd";
  reason: string;
  ok: true;
}

// A single fs.access() miss is not durable death evidence for a cwd: a
// legitimate CONCURRENT reap of this exact agent closes its tab before
// removing its worktree (teardown.ts), so a reconciliation pass racing that
// exact window can sample the cwd gone microseconds before the tab-closed
// state would otherwise have removed it from `liveAgents` on the next
// listing. One re-check after a short pause rules out that race without
// meaningfully slowing a pass where nothing is actually missing (the common
// case never pays the delay).
const RECHECK_DELAY_MS = 500;

/**
 * Cheap, total, cause-agnostic guard: any LIVE agent whose recorded `cwd` no
 * longer exists on disk is flagged, regardless of how its tree vanished
 * (this campaign's own occupancy hazard, a manual `rm`, anything nobody has
 * thought of yet). Runs over EVERY live agent, not just orphans — a flagged
 * agent is still live and reporting in, which is precisely what makes it
 * invisible to the orphan loop in `throne-startup-reconciliation.service.ts`
 * (it never enters `orphans` at all) and to `reap-agent`'s parentage-only
 * child check. Deliberately does not act (resume/reap) on its own: every
 * tool call from an agent whose cwd is gone fails at path resolution, so
 * its own recorded identity/supervisor cannot be trusted to self-correct —
 * a human-in-the-loop-shaped nudge (a loud warning + outcome record) is
 * the safe default; automatic teardown belongs to `reap-agent`, which the
 * warning names directly.
 */
export async function flagLiveCwdOrphans(
  liveAgents: HerdrAgent[],
  contract: {
    pathExists: (target: string) => Promise<boolean>;
    warn: (message: string) => void;
  },
): Promise<CwdGuardOutcome[]> {
  const outcomes: CwdGuardOutcome[] = [];
  for (const agent of liveAgents) {
    const name = agent.tabLabel ?? agent.name;
    if (name === undefined || agent.cwd === undefined || agent.cwd.length === 0) {
      continue;
    }
    let exists: boolean;
    try {
      exists = await contract.pathExists(agent.cwd);
      // One re-check before treating absence as durable — see
      // RECHECK_DELAY_MS above.
      if (!exists) {
        await sleep(RECHECK_DELAY_MS);
        exists = await contract.pathExists(agent.cwd);
      }
    } catch (error) {
      contract.warn(
        `throne-startup: reconciliation — cannot confirm whether LIVE agent ` +
          `"${name}"'s recorded cwd "${agent.cwd}" still exists (${errorText(error)}); ` +
          `skipping the cwd-occupancy check for it this pass\n`,
      );
      continue;
    }
    if (exists) continue;
    const reason = `recorded cwd "${agent.cwd}" does not exist on disk`;
    contract.warn(
      `throne-startup: reconciliation — LIVE agent "${name}" (status ` +
        `${agent.agentStatus}, pane ${agent.paneId}) has a recorded cwd ` +
        `"${agent.cwd}" that no longer exists on disk. Every tool call it makes ` +
        `fails at path resolution, so it cannot self-exit or report; its tree ` +
        `was likely removed out from under it (e.g. a reap of a DIFFERENT ` +
        `agent's worktree it was occupying). Investigate and clear with ` +
        `reap-agent ${name} --reason cancelled --force.\n`,
    );
    outcomes.push({ name, action: "flag-missing-cwd", reason, ok: true });
  }
  return outcomes;
}
