import { Module } from '@nestjs/common';
import {
  AGENT_STATUSES_COMMAND_DEPENDENCIES,
  AgentStatusesCommand,
  DEFAULT_AGENT_STATUSES_COMMAND_DEPENDENCIES,
} from './agent-statuses.command.ts';

@Module({
  providers: [
    {
      provide: AGENT_STATUSES_COMMAND_DEPENDENCIES,
      useValue: DEFAULT_AGENT_STATUSES_COMMAND_DEPENDENCIES,
    },
    AgentStatusesCommand,
  ],
})
export class AgentStatusesModule {}
