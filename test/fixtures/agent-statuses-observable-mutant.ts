import {
  AgentStatusesCommand,
  type AgentStatusesCommandDependencies,
} from '../../src/agent-statuses/agent-statuses.command.ts';

export const AGENT_STATUSES_MUTANT_STDOUT = 'observable mutant\n';

export class AgentStatusesObservableMutant extends AgentStatusesCommand {
  constructor(dependencies: AgentStatusesCommandDependencies) {
    super(dependencies);
  }

  override async run(passedParams: string[]): Promise<void> {
    await super.run(passedParams);
    process.stdout.write(AGENT_STATUSES_MUTANT_STDOUT);
  }
}
