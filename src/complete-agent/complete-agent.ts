import {
  AGENT_LIFECYCLE_STATES,
  type AgentStatusesRosterEntry,
} from "../agent-statuses/agent-statuses.types.ts";
import { REAP_REASON, type ReapReason } from "../agent-timings/reap-reason.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { REGENT_NAME } from "../regent-state/regent-state.service.ts";
import type { SliceEvidenceResult } from "../slice-evidence/agent-evidence-gate.ts";
import { describeUnmetEvidenceRefusal } from "../slice-evidence/agent-evidence-gate.ts";
import type { readAgent } from "../herdr/herdr-runtime.service.ts";
import type { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  hasDurableVerdictOnlyShape,
  isCompletionProvenVerdictOnlyAgent,
} from "../reap-agent/reapability-claim.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";

const ALL_FLAG = "--all";

const USAGE =
  "Usage: ./bin/throne-cli complete-agent <name> | --all\n" +
  "Reaps COMPLETE and completion-proven, non-working LIVE agents; every other LIVE agent requires reap-agent <name> --force --reason force.\n";

export interface CompleteAgentDependencies {
  getRoster: () => Promise<AgentStatusesRosterEntry[]>;
  reap: (name: string, reason: ReapReason) => Promise<number>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  /** A second, independent completion signal: true when a `Deliver <name>`
   *  commit (stamped by `mergeBack`, see `git-lifecycle/merge.ts`) is
   *  reachable in its target repository's history. Falls back to refusing
   *  on REPORT.md alone when omitted (e.g. in older/simplified callers). */
  hasDeliveryCommit?: (name: string) => Promise<boolean>;
  readAgent?: typeof readAgent;
  readSpawnSpec?: typeof readSpawnSpec;
  /** A stated-evidence gate: `ok: true` when the agent's own ASSIGNMENT.md
   *  states no `Evidence required:` line, or its REPORT.md satisfies the one
   *  it does state. Falls back to allowing reap when omitted (e.g. in
   *  older/simplified callers), matching `hasDeliveryCommit`'s convention. */
  checkEvidenceRequirement?: (name: string) => Promise<SliceEvidenceResult>;
}

interface Parsed {
  name?: string;
  all: boolean;
}

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { all: false };
  for (const [index, arg] of args.entries()) {
    if (arg === ALL_FLAG) {
      parsed.all = true;
    } else if (arg === "--name" || arg.startsWith("--name=")) {
      // complete-agent takes a bare positional <name>, unlike reap-agent's
      // `--name`/`--reason` flags — the mix-up is common enough (it's the
      // exact usage error the Regent hit reaping a completion-proven Alpha)
      // to name the fix inline instead of just "unknown flag".
      const inlineValue = arg.startsWith("--name=") ? arg.slice("--name=".length) : undefined;
      const positional = inlineValue ?? args[index + 1];
      throw new Error(
        `"${arg}" is not a flag here — complete-agent takes a bare positional ` +
          `<name>, e.g. complete-agent ${positional ?? "<name>"}`,
      );
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag "${arg}"`);
    } else if (parsed.name === undefined) {
      parsed.name = arg;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  if (parsed.all && parsed.name !== undefined) {
    throw new Error(`cannot combine a <name> with ${ALL_FLAG}`);
  }
  if (!parsed.all && parsed.name === undefined) {
    throw new Error(`need a <name> or ${ALL_FLAG}`);
  }
  return parsed;
}

function isDoneButStuck(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
    entry.reportLanded &&
    entry.liveStatus !== "working"
  );
}

/** A LIVE agent that finished working but never self-exited, and whose
 *  REPORT.md is (for whatever reason) not landed — e.g. the report lives
 *  only under a Shadow's directory the roster doesn't scan, or the herdr
 *  pane label doesn't exactly match the registered name. `reportLanded`
 *  proved nothing here, so `completeOne` falls back to asking git for the
 *  `Deliver <name>` commit `mergeBack` stamps on real completion. */
function isLiveNotWorkingWithoutReport(entry: AgentStatusesRosterEntry): boolean {
  return (
    entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE &&
    !entry.reportLanded &&
    entry.liveStatus !== "working"
  );
}

function evidenceUnmetMessage(name: string, result: SliceEvidenceResult): string {
  return `complete-agent: ${describeUnmetEvidenceRefusal(name, result)}\n`;
}

/** Applies the stated-evidence gate, then reaps and announces readiness only
 *  when it holds — every existing reap path funnels through here so no call
 *  site can bypass the check. */
async function reapWithEvidenceGate(
  name: string,
  dependencies: CompleteAgentDependencies,
  announceReady: () => void,
): Promise<number> {
  const evidenceResult = await dependencies.checkEvidenceRequirement?.(name);
  if (evidenceResult !== undefined && !evidenceResult.ok) {
    dependencies.writeStderr(evidenceUnmetMessage(name, evidenceResult));
    return 1;
  }
  announceReady();
  return dependencies.reap(name, REAP_REASON.COMPLETED);
}

function readyMessage(
  entry: AgentStatusesRosterEntry,
  out: (text: string) => void,
  provenByDeliveryCommit = false,
): void {
  if (provenByDeliveryCommit) {
    out(
      `complete-agent: "${entry.name}" is completion-proven (no REPORT.md, ` +
        `but a "Deliver ${entry.name}" commit is in its target repository's history and ` +
        `LIVE status is ${entry.liveStatus ?? "unknown"}; it could not self-exit) ` +
        "— reaping.\n",
    );
  } else if (isDoneButStuck(entry)) {
    out(
      `complete-agent: "${entry.name}" is completion-proven (REPORT.md landed ` +
        `but LIVE status ${entry.liveStatus ?? "unknown"}; it could not ` +
        `self-exit) — reaping.\n`,
    );
  } else out(`complete-agent: "${entry.name}" is COMPLETE — reaping.\n`);
}

async function completeOne(
  name: string,
  roster: AgentStatusesRosterEntry[],
  dependencies: CompleteAgentDependencies,
): Promise<number> {
  if (sameAgentName(name, REGENT_NAME)) {
    dependencies.writeStderr(
      "complete-agent: refusing to reap the Regent — it is managed by the " +
        "self-heal watchdog (summon/dismiss), not reaped. Use dismiss-regent " +
        "to stand the court down.\n",
    );
    return 1;
  }
  const entry = roster.find((candidate) => sameAgentName(candidate.name, name));
  if (entry === undefined) {
    dependencies.writeStdout(
      `complete-agent: "${name}" is not a known agent (never existed or ` +
        "already reaped) — nothing to do.\n",
    );
    return 0;
  }
  if (entry.lifecycle === AGENT_LIFECYCLE_STATES.LIVE) {
    if (isDoneButStuck(entry)) {
      return reapWithEvidenceGate(name, dependencies, () =>
        readyMessage(entry, dependencies.writeStdout),
      );
    }
    if (entry.reportLanded) {
      dependencies.writeStderr(
        `complete-agent: "${name}" has a completion REPORT.md, but is LIVE ` +
          "(status working) — herdr says it is actively working. Wait and retry, or force teardown " +
          `with reap-agent ${name} --force --reason force.\n`,
      );
      return 1;
    }
    if (
      isLiveNotWorkingWithoutReport(entry) &&
      (await isCompletionProvenVerdictOnlyAgent(
        name,
        entry.liveStatus,
        dependencies,
      ))
    ) {
      return reapWithEvidenceGate(name, dependencies, () =>
        dependencies.writeStdout(
          `complete-agent: "${name}" is completion-proven (durable ` +
            `verdict-only deliverable and latest completed reapability claim; ` +
            `LIVE status is ${entry.liveStatus ?? "unknown"}) — reaping.\n`,
        ),
      );
    }
    if (
      isLiveNotWorkingWithoutReport(entry) &&
      !(await hasDurableVerdictOnlyShape(name, dependencies)) &&
      (await dependencies.hasDeliveryCommit?.(name))
    ) {
      return reapWithEvidenceGate(name, dependencies, () =>
        readyMessage(entry, dependencies.writeStdout, true),
      );
    }
    if (entry.liveStatus === "working") {
      if (await dependencies.hasDeliveryCommit?.(name)) {
        dependencies.writeStderr(
          `complete-agent: "${name}" is completion-proven (a "Deliver ${name}" ` +
            "commit is already in its target repository's history) but still reports LIVE " +
            "(status working) — it has not gone quiet yet. Wait and retry; this " +
            "is a transient, self-resolving state, not a stuck agent.\n",
        );
        return 1;
      }
      dependencies.writeStderr(
        `complete-agent: "${name}" is LIVE (status ${entry.liveStatus}) ` +
          "— still working, not complete. Refusing. (Force a teardown with " +
          "reap-agent <name> --force --reason force.)\n",
      );
      return 1;
    }
    dependencies.writeStderr(
      `complete-agent: "${name}" is LIVE (status ${entry.liveStatus ?? "unknown"}) ` +
        `with no REPORT.md landed and no "Deliver ${name}" commit found in ` +
        "its target repository's history — not provably complete. This is often the correct, " +
        "expected state for a Shadow that has not merged its work back yet. " +
        "Refusing. (A genuinely stuck agent can still be torn down with " +
        "reap-agent <name> --force --reason force.)\n",
    );
    return 1;
  }
  if (entry.lifecycle === AGENT_LIFECYCLE_STATES.DEAD) {
    if (await dependencies.hasDeliveryCommit?.(name)) {
      return reapWithEvidenceGate(name, dependencies, () =>
        dependencies.writeStdout(
          `complete-agent: "${name}" is completion-proven (DEAD, no REPORT.md, ` +
            `but a "Deliver ${name}" commit is in its target repository's history — it died ` +
            "after finishing, not mid-work) — reaping.\n",
        ),
      );
    }
    dependencies.writeStderr(
      `complete-agent: "${name}" is DEAD (registered, process gone, no ` +
        "completion REPORT.md) — it died mid-work, not complete. Refusing. (Resume-or-reap of an " +
        "orphan is the Regent's call; force a teardown with reap-agent <name> --force --reason force.)\n",
    );
    return 1;
  }
  if (entry.lifecycle === AGENT_LIFECYCLE_STATES.COMPLETE) {
    return reapWithEvidenceGate(name, dependencies, () =>
      readyMessage(entry, dependencies.writeStdout),
    );
  }
  dependencies.writeStderr(
    `complete-agent: "${name}" has lifecycle "${entry.lifecycle}", not COMPLETE ` +
      "— refusing (only a COMPLETE agent is reap-ready).\n",
  );
  return 1;
}

export async function runCompleteAgent(
  args: string[],
  dependencies: CompleteAgentDependencies,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(
      `complete-agent: ${message}\n${renderEntranceRefusal({
        reason: "complete-agent entrance validation rejected the supplied completion selector.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n${USAGE}`,
    );
    return 1;
  }
  let roster: AgentStatusesRosterEntry[];
  try {
    roster = await dependencies.getRoster();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(
      `complete-agent: cannot read the agent roster (${message}) — ` +
        "refusing; cannot prove any agent is complete.\n",
    );
    return 1;
  }
  if (!parsed.all) return completeOne(parsed.name!, roster, dependencies);
  const commitProven = new Set<string>();
  const verdictOnlyProven = new Set<string>();
  for (const entry of roster) {
    if (!isLiveNotWorkingWithoutReport(entry)) continue;
    if (
      await isCompletionProvenVerdictOnlyAgent(
        entry.name,
        entry.liveStatus,
        dependencies,
      )
    ) verdictOnlyProven.add(entry.name);
    else if (
      !(await hasDurableVerdictOnlyShape(entry.name, dependencies)) &&
      (await dependencies.hasDeliveryCommit?.(entry.name))
    ) commitProven.add(entry.name);
  }
  const ready = roster.filter(
    (entry) =>
      entry.lifecycle === AGENT_LIFECYCLE_STATES.COMPLETE ||
      isDoneButStuck(entry) ||
      verdictOnlyProven.has(entry.name) ||
      commitProven.has(entry.name),
  );
  if (ready.length === 0) {
    dependencies.writeStdout(
      "complete-agent: no COMPLETE or completion-proven stuck agents to reap.\n",
    );
    return 0;
  }
  let failures = 0;
  for (const entry of ready) {
    const evidenceResult = await dependencies.checkEvidenceRequirement?.(entry.name);
    if (evidenceResult !== undefined && !evidenceResult.ok) {
      failures++;
      dependencies.writeStderr(evidenceUnmetMessage(entry.name, evidenceResult));
      continue;
    }
    if (verdictOnlyProven.has(entry.name)) {
      dependencies.writeStdout(
        `complete-agent: "${entry.name}" is completion-proven (durable ` +
          `verdict-only deliverable and latest completed reapability claim; ` +
          `LIVE status is ${entry.liveStatus ?? "unknown"}) — reaping.\n`,
      );
    } else readyMessage(entry, dependencies.writeStdout, commitProven.has(entry.name));
    const code = await dependencies.reap(entry.name, REAP_REASON.COMPLETED);
    if (code !== 0) {
      failures++;
      dependencies.writeStderr(
        `complete-agent: reaping "${entry.name}" failed (exit ${code}).\n`,
      );
    }
  }
  dependencies.writeStdout(
    `complete-agent: swept ${ready.length - failures}/${ready.length} ` +
      "completion-proven agent(s).\n",
  );
  return failures === 0 ? 0 : 1;
}
