import { Module } from '@nestjs/common';
import {
  NO_IDLING_DEPENDENCIES,
  NoIdlingCommand,
  REAL_NO_IDLING_DEPENDENCIES,
} from './no-idling.command.ts';

@Module({
  providers: [
    {
      provide: NO_IDLING_DEPENDENCIES,
      useValue: REAL_NO_IDLING_DEPENDENCIES,
    },
    NoIdlingCommand,
  ],
})
export class NoIdlingModule {}
