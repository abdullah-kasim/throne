// Standalone, additive safety net for the create-agent -> send-agent
// tasking seam: `create-agent` puts a live harness in a worktree and
// `send-agent` tells it what to do, and those are two separate operations —
// missing the second leaves a live agent holding a concurrency slot at its
// bare identity prompt forever, invisible to every check that only asks
// "is this agent healthy," because it IS healthy; it just has nothing to
// do (shadow-tbk-09, 2026-08-11). `find-untasked-agents` names that
// specific failure per-agent, independent of `no-idling`'s whole-family
// idle gate — see `find-untasked-agents.ts` for why the family gate alone
// cannot catch it. It touches no code create-agent/send-agent/no-idling
// already run; it is a new, separate CLI command an operator or a periodic
// sweep may invoke alongside them.

import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import { getAgentStatusesRoster } from '../agent-statuses/agent-statuses-roster.ts';
import { readSpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import {
  findUntaskedAgents,
  type FindUntaskedAgentsEvidence,
  type UntaskedAgent,
} from './find-untasked-agents.ts';

export interface FindUntaskedAgentsDependencies {
  getRoster: () => ReturnType<typeof getAgentStatusesRoster>;
  readSpawnSpec: (name: string) => ReturnType<typeof readSpawnSpec>;
  now?: () => number;
}

export const REAL_FIND_UNTASKED_AGENTS_DEPENDENCIES: FindUntaskedAgentsDependencies = {
  getRoster: () => getAgentStatusesRoster(),
  readSpawnSpec: (name) => readSpawnSpec(name, RUNTIME_DATA_DIR),
};

function formatUntaskedAgent(agent: UntaskedAgent): string {
  const ageMinutes = Math.floor(agent.ageMs / 60_000);
  return `${agent.name} (${agent.role}) — idle and untasked for ~${ageMinutes}m`;
}

/** Thin CLI wrapper — no args, reports and returns a distinguishable exit code. */
export async function runFindUntaskedAgents(
  deps: FindUntaskedAgentsDependencies = REAL_FIND_UNTASKED_AGENTS_DEPENDENCIES,
): Promise<number> {
  const evidence: FindUntaskedAgentsEvidence = {
    roster: await deps.getRoster(),
    readSpawnSpec: deps.readSpawnSpec,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  const untasked = await findUntaskedAgents(evidence);
  if (untasked.length === 0) {
    process.stdout.write('find-untasked-agents: none found\n');
    return 0;
  }
  process.stdout.write(
    `find-untasked-agents: ${untasked.length} live agent(s) spawned but never tasked:\n`,
  );
  for (const agent of untasked) {
    process.stdout.write(`  ${formatUntaskedAgent(agent)}\n`);
  }
  return 1;
}

// No constructor: Nest's legacy-decorator metadata erases the interface
// type `FindUntaskedAgentsDependencies` to a bare `Object` at runtime, which
// Nest's DI container cannot resolve as a token, so a constructor parameter
// here throws `UnknownDependenciesException` at application-context
// bootstrap — same reasoning `CheckSliceEvidenceCommand` follows. Real
// dependencies are the module-level default; tests exercise
// `runFindUntaskedAgents` directly instead of constructing the command.
@Command({
  name: 'find-untasked-agents',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class FindUntaskedAgentsCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(_passedParams: string[]): Promise<void> {
    process.exitCode = await runFindUntaskedAgents();
  }
}
