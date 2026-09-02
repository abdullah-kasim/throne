import type { UsageLogRow } from '../plan-usage-remaining/telemetry-core/log.ts';
import { computeUsageRates, type RateResult } from './usagerate.ts';

/** Nest owner for the rate calculation policy used by usage-rate output. */
export class UsageRateCalculationService {
  calculate(rows: UsageLogRow[]): { anchor: string | null; results: RateResult[] } {
    return computeUsageRates(rows);
  }
}
