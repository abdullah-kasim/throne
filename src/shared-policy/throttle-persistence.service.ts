import {
  readThrottleState,
  writeThrottleState,
  type ThrottleState,
} from './usagethrottle.ts';

/** Nest owner for durable throttle state persistence. */
export class ThrottlePersistenceService {
  read(dir: string): Promise<ThrottleState> {
    return readThrottleState(dir);
  }

  write(state: ThrottleState, dir: string): Promise<void> {
    return writeThrottleState(state, dir);
  }
}
