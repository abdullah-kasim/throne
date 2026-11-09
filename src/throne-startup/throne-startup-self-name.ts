import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-inventory.service.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import { errorText } from "../shared-policy/error-text.ts";
import type { ThroneStartupDeps } from "./throne-startup.ts";

type SelfNameDeps = Pick<ThroneStartupDeps, "agentNameAtLaunch" | "renameAgent">;

/**
 * Decide + apply the self-rename for a confirmed throne-root pane, and report
 * whether this harness IS the Regent (so the caller can also claim its tab).
 * Renames to `Regent` ONLY when the pane is unnamed AND no agent already holds
 * the `Regent` name (`!own.name` covers both an absent field and an empty
 * string; the second clause prevents a duplicate Regent and makes re-runs
 * idempotent — once renamed, `own.name` is `Regent`). Returns `true` iff this
 * harness is (or just became) the Regent: an already-`Regent` pane (self-heal),
 * or a successful fresh rename. Returns `false` for a pane named something else,
 * a skip because another Regent exists, or a rename that failed. Any skip logs
 * its specific reason; a rename that itself fails is caught and logged, never
 * aborting.
 */
function launchedAsAnotherAgent(deps: SelfNameDeps): string | undefined {
  const launchedAs = deps.agentNameAtLaunch?.();
  return launchedAs && !sameAgentName(launchedAs, REGENT_NAME) ? launchedAs : undefined;
}

export async function maybeRenameSelf(
  own: HerdrAgent,
  agents: HerdrAgent[],
  deps: SelfNameDeps,
): Promise<boolean> {
  if (own.name) {
    process.stdout.write(
      `throne-startup: harness already named "${own.name}"; skipping self-rename\n`,
    );
    return sameAgentName(own.name, REGENT_NAME);
  }
  const anotherAgent = launchedAsAnotherAgent(deps);
  if (anotherAgent !== undefined) {
    process.stdout.write(
      `throne-startup: launched as "${anotherAgent}"; skipping self-rename\n`,
    );
    return false;
  }
  if (agents.some((agent) => sameAgentName(agent.name, REGENT_NAME))) {
    process.stdout.write(
      `throne-startup: a "${REGENT_NAME}" already exists; skipping self-rename\n`,
    );
    return false;
  }
  try {
    await deps.renameAgent(own.paneId, REGENT_NAME);
    process.stdout.write(`throne-startup: renamed self to "${REGENT_NAME}"\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `throne-startup: self-rename to "${REGENT_NAME}" failed (${errorText(err)}); continuing\n`,
    );
    return false;
  }
}
