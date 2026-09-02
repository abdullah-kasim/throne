import { Command as CommanderCommand } from 'commander';
import { Inject } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { getAgentStatusesRoster } from './agent-statuses-roster.ts';
import {
  describeAgentStatusesDesiredState,
  readAgentStatusesDesiredState,
} from './agent-statuses-state.ts';
import type { AgentStatusesRosterEntry } from './agent-statuses.types.ts';

type AgentStatusesRow = [string, string, string, string, string, string];

const AGENT_STATUSES_HEADER: AgentStatusesRow = [
  'NAME',
  'ROLE',
  'STATE',
  'STATUS',
  'CWD',
  'PANE',
];
const EMPTY_AGENT_STATUS_CELL = '—';

export interface AgentStatusesCommandDependencies {
  readonly getAgentStatusesRoster: typeof getAgentStatusesRoster;
  readonly readAgentStatusesDesiredState: typeof readAgentStatusesDesiredState;
}

export const AGENT_STATUSES_COMMAND_DEPENDENCIES = Symbol(
  'AGENT_STATUSES_COMMAND_DEPENDENCIES',
);

export const DEFAULT_AGENT_STATUSES_COMMAND_DEPENDENCIES: AgentStatusesCommandDependencies = {
  getAgentStatusesRoster,
  readAgentStatusesDesiredState,
};

export function agentStatusesRow(
  entry: AgentStatusesRosterEntry,
): AgentStatusesRow {
  return [
    entry.focused ? `${entry.name} *` : entry.name,
    entry.role ?? EMPTY_AGENT_STATUS_CELL,
    entry.lifecycle.toUpperCase(),
    entry.liveStatus ?? EMPTY_AGENT_STATUS_CELL,
    entry.cwd ?? EMPTY_AGENT_STATUS_CELL,
    entry.paneId ?? EMPTY_AGENT_STATUS_CELL,
  ];
}

export function renderAgentStatusesTable(rows: AgentStatusesRow[]): string {
  const allRows = [AGENT_STATUSES_HEADER, ...rows];
  const widths = AGENT_STATUSES_HEADER.map((_, column) =>
    Math.max(...allRows.map((row) => row[column].length)),
  );
  return allRows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

@Command({
  name: 'agent-statuses',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AgentStatusesCommand extends CommandRunner {
  private readonly dependencies: AgentStatusesCommandDependencies;

  constructor(
    @Inject(AGENT_STATUSES_COMMAND_DEPENDENCIES)
    dependencies: AgentStatusesCommandDependencies =
      DEFAULT_AGENT_STATUSES_COMMAND_DEPENDENCIES,
  ) {
    super();
    this.dependencies = dependencies;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(_passedParams: string[]): Promise<void> {
    const desiredState = await this.dependencies.readAgentStatusesDesiredState();
    process.stdout.write(
      `Regent desired-state: ${describeAgentStatusesDesiredState(desiredState)}\n`,
    );

    const roster = await this.dependencies.getAgentStatusesRoster();
    if (roster.length === 0) {
      process.stdout.write('no agents\n');
      process.exitCode = 0;
      return;
    }

    process.stdout.write(
      `${renderAgentStatusesTable(roster.map(agentStatusesRow))}\n`,
    );
    process.exitCode = 0;
  }
}
