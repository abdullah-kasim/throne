import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { runReapAgent } from './reap-agent-runtime.ts';
import type { ReapDeps } from './reap-agent.types.ts';


let configuredDependencies: ReapDeps | undefined;

export function configureReapAgentDependencies(dependencies: ReapDeps): void {
  configuredDependencies = dependencies;
}

@Command({
  name: 'reap-agent',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ReapAgentCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runReapAgent(passedParams, configuredDependencies);
  }
}
