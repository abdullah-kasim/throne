import type { JevSpending } from './jev-spending.ts';
import type { JevSwitch } from './jev-switch.ts';

export const SWITCHED_OFF_JEV_STATUS_READERS = {
  readJevSwitch: (): Promise<JevSwitch> =>
    Promise.resolve({
      on: false,
      enabledInConfig: false,
      disabledByEnvironment: false,
      keyFile: 'not-checked',
      keyFilePath: '/keys/jev',
    }),
  readJevSpending: (): Promise<JevSpending> =>
    Promise.resolve({
      spend: { todayTokens: 0, lastHourTokens: 0 },
      limits: { tokensPerDay: 1, tokensPerHour: 1 },
      lockBusyRequestsToday: 0,
    }),
};
