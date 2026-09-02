import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { runAgentLogs, type AgentLogsReader } from './agent-logs.ts';

let productionReadAgent: AgentLogsReader | undefined;

export function configureAgentLogsReader(readAgent: AgentLogsReader): void {
  productionReadAgent = readAgent;
}

@Command({
  name: 'agent-logs',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AgentLogsCommand extends CommandRunner {
  private readonly readAgent?: AgentLogsReader;

  constructor(readAgent?: AgentLogsReader) {
    super();
    this.readAgent = readAgent;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const readAgent = this.readAgent ?? productionReadAgent;
    if (readAgent === undefined) {
      throw new Error('agent-logs reader is not configured');
    }
    process.exitCode = await runAgentLogs(passedParams, readAgent);
  }
}

