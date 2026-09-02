import { Module } from '@nestjs/common';
import { ReadPayloadCommand } from './read-payload.command.ts';

@Module({
  providers: [
    {
      provide: ReadPayloadCommand,
      useFactory: () => new ReadPayloadCommand(),
    },
  ],
})
export class ReadPayloadModule {}
