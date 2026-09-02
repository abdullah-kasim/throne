import { Module } from '@nestjs/common';
import { KeepGoingCommand } from './keep-going.command.ts';

@Module({
  providers: [
    {
      provide: KeepGoingCommand,
      useFactory: () => new KeepGoingCommand(),
    },
  ],
})
export class KeepGoingModule {}
