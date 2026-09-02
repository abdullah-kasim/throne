import { Module } from '@nestjs/common';
import { SwitchAgentModelCommand } from './switch-agent-model.command-registration.ts';

@Module({ providers: [SwitchAgentModelCommand] })
export class SwitchAgentModelModule {}
