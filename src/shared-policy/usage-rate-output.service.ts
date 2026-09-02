import type { RateResult } from './usagerate.ts';
import { formatUsageRateHuman } from './usage-rate-output.ts';

/** Nest owner for the human usage-rate presentation policy. */
export class UsageRateOutputService {
  format(anchor: string, results: RateResult[]): string[] {
    return formatUsageRateHuman(anchor, results);
  }
}
