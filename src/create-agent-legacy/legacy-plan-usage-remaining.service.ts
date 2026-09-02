import { errorText } from "../shared-policy/error-text.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import {
  mapUsageWindows,
  type TelemetryRuntime,
  PlanUsageTelemetryService,
  UsageCacheService,
  UsageLogService,
  ForecastSampleService,
  WeeklyResetService,
} from "../plan-usage-remaining/plan-usage-telemetry.service.ts";
import type { UsagePayload } from "../plan-usage-remaining/telemetry.types.ts";
import { PlanUsageAuthenticationService } from "../plan-usage-remaining/plan-usage-authentication.service.ts";
import { PlanUsagePlatformService } from "../plan-usage-remaining/plan-usage-platform.service.ts";
import { PlanUsageHistoryService } from "../plan-usage-remaining/plan-usage-history.service.ts";

export class PlanUsageRemainingService {
  private readonly runtime: TelemetryRuntime;
  private readonly telemetry: PlanUsageTelemetryService;
  private readonly authentication: PlanUsageAuthenticationService;

  constructor(
    runtime: TelemetryRuntime,
    telemetry: PlanUsageTelemetryService,
    authentication: PlanUsageAuthenticationService,
  ) {
    this.runtime = runtime;
    this.telemetry = telemetry;
    this.authentication = authentication;
  }

  async getUsagePayload(): Promise<UsagePayload> {
    const payload = await this.computeLiveUsagePayload();
    return this.telemetry.enrich(payload);
  }

  private async computeLiveUsagePayload(): Promise<UsagePayload> {
    const asOf = this.runtime.now().toISOString();
    try {
      const usage = await this.authentication.fetchUsage();
      const { windows, unreadableWindows } = mapUsageWindows(usage);
      return {
        source: "api",
        harness: HARNESS_NAMES.CLAUDE,
        as_of: asOf,
        windows,
        ...(unreadableWindows.length > 0
          ? { unreadable_windows: unreadableWindows }
          : {}),
      };
    } catch (error) {
      return {
        source: "error",
        harness: HARNESS_NAMES.CLAUDE,
        as_of: asOf,
        error: errorText(error),
      };
    }
  }
}

/**
 * Wires a real `PlanUsageRemainingService` with real collaborators, exactly
 * matching application.module.ts's Nest factory. Direct-CLI entrypoints that
 * run outside Nest DI (create.ts, switch-agent-model, usagethrottle) use this
 * so native Claude usage reads actually work instead of always failing with
 * "PlanUsageRemainingService is required for Claude usage".
 */
export function realPlanUsageRemainingService(
  platform: PlanUsagePlatformService = new PlanUsagePlatformService(),
): PlanUsageRemainingService {
  const telemetry = new PlanUsageTelemetryService(
    new UsageCacheService(platform.runtime),
    new UsageLogService(new PlanUsageHistoryService(platform)),
    new ForecastSampleService(),
    new WeeklyResetService(),
  );
  const authentication = new PlanUsageAuthenticationService(platform);
  return new PlanUsageRemainingService(
    platform.runtime,
    telemetry,
    authentication,
  );
}
