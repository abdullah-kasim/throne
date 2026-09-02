import {
  contemporaneousWeeklyReset,
  isFableWeeklyReading,
} from './telemetry-core/weekly-reset.ts';
import {
  cachedUsage,
  USAGE_CACHE_TTL_MS,
  type CacheablePayload,
} from './telemetry-core/cache.ts';
import {
  getBoundedForecastSamples,
  parseUsageLog,
} from './telemetry-core/log.ts';
import { forecastUsageAtReset } from './telemetry-core/forecast.ts';
import type { PlanUsageDeps } from './pipeline.types.ts';
import type {
  UnreadableUsageWindow,
  UsagePayload,
  UsageWindow,
} from './telemetry.types.ts';
import { PlanUsageHistoryService } from './plan-usage-history.service.ts';
import { MODEL_NAMES } from '../harness-routing/harness.ts';

export type TelemetryRuntime = PlanUsageDeps;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LimitEntry {
  kind: string;
  severity?: string;
  percent: number;
  resetsAt?: string;
  scopeModelDisplayName?: string;
}

export interface MappedUsageWindows {
  windows: UsageWindow[];
  unreadableWindows: UnreadableUsageWindow[];
}

function parseLimits(value: unknown): LimitEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: LimitEntry[] = [];
  for (const raw of value) {
    if (!isJsonRecord(raw) || typeof raw.kind !== 'string') continue;
    const scope = isJsonRecord(raw.scope) ? raw.scope : undefined;
    const model = scope !== undefined && isJsonRecord(scope.model) ? scope.model : undefined;
    entries.push({
      kind: raw.kind,
      severity: typeof raw.severity === 'string' ? raw.severity : undefined,
      percent: typeof raw.percent === 'number' ? raw.percent : Number.NaN,
      resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : undefined,
      scopeModelDisplayName: model !== undefined && typeof model.display_name === 'string'
        ? model.display_name
        : undefined,
    });
  }
  return entries;
}

function parseTopWindow(value: unknown, capWindow: string, severity: string | undefined): UsageWindow | null {
  if (value === null || value === undefined) return null;
  if (!isJsonRecord(value)) throw new Error(`Claude usage window "${capWindow}" had an unexpected shape`);
  if (typeof value.utilization !== 'number' || typeof value.resets_at !== 'string') {
    throw new Error(`Claude usage window "${capWindow}" was missing utilization/resets_at`);
  }
  return {
    cap_window: capWindow,
    used_pct: value.utilization,
    remaining_pct: 100 - value.utilization,
    reset_time: value.resets_at,
    severity,
  };
}

function inheritFableWeeklyReset(windows: UsageWindow[]): UsageWindow[] {
  const inheritedReset = contemporaneousWeeklyReset(windows);
  if (inheritedReset === undefined) return windows;
  return windows.map((window) => isFableWeeklyReading(window) && window.reset_time === undefined
    ? { ...window, reset_time: inheritedReset }
    : window);
}

export function mapUsageWindows(usage: Record<string, unknown>): MappedUsageWindows {
  if (usage.five_hour === undefined && usage.seven_day === undefined) {
    throw new Error('Claude usage response was missing both the five_hour and seven_day windows');
  }
  const limits = parseLimits(usage.limits);
  const windows: UsageWindow[] = [];
  const unreadableWindows: UnreadableUsageWindow[] = [];
  const severity = (kind: string) => limits.find((entry) => entry.kind === kind)?.severity;
  const fiveHour = parseTopWindow(usage.five_hour, '5h', severity('session'));
  if (fiveHour) windows.push(fiveHour);
  const weekly = parseTopWindow(usage.seven_day, 'weekly', severity('weekly_all'));
  if (weekly) windows.push(weekly);
  for (const entry of limits) {
    if (entry.kind !== 'weekly_scoped' || entry.scopeModelDisplayName === undefined) continue;
    const capWindow = `weekly:${entry.scopeModelDisplayName}`;
    if (!Number.isFinite(entry.percent)) {
      unreadableWindows.push({ cap_window: capWindow, scope_model: entry.scopeModelDisplayName, reset_time: entry.resetsAt, issue: 'invalid-percentage' });
      continue;
    }
    windows.push({ cap_window: capWindow, used_pct: entry.percent, remaining_pct: 100 - entry.percent, reset_time: entry.resetsAt, severity: entry.severity, scope_model: entry.scopeModelDisplayName });
  }
  if (!limits.some((entry) => entry.kind === 'weekly_scoped' && entry.scopeModelDisplayName?.toLowerCase() === MODEL_NAMES.OPUS)) {
    const legacy = usage.seven_day_opus;
    if (legacy !== null && legacy !== undefined && isJsonRecord(legacy) && typeof legacy.utilization === 'number' && Number.isFinite(legacy.utilization) && typeof legacy.resets_at === 'string') {
      windows.push({ cap_window: 'weekly:Opus', used_pct: legacy.utilization, remaining_pct: 100 - legacy.utilization, reset_time: legacy.resets_at, scope_model: 'Opus' });
    }
  }
  return { windows: inheritFableWeeklyReset(windows), unreadableWindows };
}

export class UsageCacheService {
  private readonly runtime: TelemetryRuntime;
  constructor(runtime: TelemetryRuntime) { this.runtime = runtime; }
  readThrough<T extends CacheablePayload>(fetchLive: () => Promise<T>): Promise<T> {
    return this.runtime.cacheIo === undefined ? fetchLive() : cachedUsage(fetchLive, this.runtime.cacheIo, USAGE_CACHE_TTL_MS);
  }
}

export class UsageLogService {
  private readonly history: PlanUsageHistoryService;
  constructor(history: PlanUsageHistoryService) { this.history = history; }
  addForecasts(payload: UsagePayload): Promise<void> { return this.history.addForecasts(payload); }
  append(payload: UsagePayload): Promise<void> { return this.history.appendReading(payload); }
}

export class ForecastSampleService {
  async forecastWindow(payload: UsagePayload, capWindow: string, runtime: TelemetryRuntime): Promise<ReturnType<typeof forecastUsageAtReset> | null> {
    const window = payload.windows?.find((candidate) => candidate.cap_window === capWindow);
    if (window === undefined || runtime.readUsageLog === undefined) return null;
    const rows = parseUsageLog(await runtime.readUsageLog());
    const samples = getBoundedForecastSamples(rows, payload.harness, capWindow, runtime.now());
    samples.push({ recorded_at: payload.as_of, remaining_pct: window.remaining_pct, reset_time: window.reset_time ?? null });
    return forecastUsageAtReset({ now: runtime.now().toISOString(), reset_time: window.reset_time ?? '', samples });
  }
}

export class WeeklyResetService {
  mapWindows(usage: Record<string, unknown>): MappedUsageWindows { return mapUsageWindows(usage); }
}

export class PlanUsageTelemetryService {
  readonly cache: UsageCacheService;
  readonly log: UsageLogService;
  readonly forecast: ForecastSampleService;
  readonly weeklyReset: WeeklyResetService;
  constructor(cache: UsageCacheService, log: UsageLogService, forecast: ForecastSampleService, weeklyReset: WeeklyResetService) {
    this.cache = cache;
    this.log = log;
    this.forecast = forecast;
    this.weeklyReset = weeklyReset;
  }
  async enrich(payload: UsagePayload): Promise<UsagePayload> {
    await this.log.addForecasts(payload);
    await this.log.append(payload);
    return payload;
  }
}
