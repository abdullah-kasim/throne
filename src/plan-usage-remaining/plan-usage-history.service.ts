import {
  buildUsageLogRows,
  getBoundedForecastSamples,
  parseUsageLog,
} from './telemetry-core/log.ts';
import { forecastUsageAtReset } from './telemetry-core/forecast.ts';
import type { PlanUsageDeps } from './pipeline.types.ts';
import type { UsagePayload } from './telemetry.types.ts';
import { PlanUsagePlatformService } from './plan-usage-platform.service.ts';

export class PlanUsageHistoryService {
  private readonly runtime: PlanUsageDeps;

  constructor(platform: PlanUsagePlatformService) {
    this.runtime = platform.runtime;
  }

  async addForecasts(payload: UsagePayload): Promise<void> {
    if (
      payload.source !== 'api' ||
      payload.windows === undefined ||
      this.runtime.readUsageLog === undefined
    ) return;
    const now = this.runtime.now();
    const rows = parseUsageLog(await this.runtime.readUsageLog());
    for (const window of payload.windows) {
      const samples = getBoundedForecastSamples(
        rows,
        payload.harness,
        window.cap_window,
        now,
      );
      samples.push({
        recorded_at: payload.as_of,
        remaining_pct: window.remaining_pct,
        reset_time: window.reset_time ?? null,
      });
      window.projected_remaining_pct = forecastUsageAtReset({
        now: now.toISOString(),
        reset_time: window.reset_time ?? '',
        samples,
      }).projected_remaining_pct;
    }
  }

  async appendReading(payload: UsagePayload): Promise<void> {
    if (this.runtime.appendUsageLog === undefined) return;
    const rows = buildUsageLogRows(payload, this.runtime.now().toISOString());
    if (rows.length === 0) return;
    try {
      await this.runtime.appendUsageLog(rows);
    } catch {
      return;
    }
  }
}
