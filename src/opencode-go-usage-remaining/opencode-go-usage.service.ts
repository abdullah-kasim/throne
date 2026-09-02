import {
  cachedUsage,
  realUsageCacheIo,
  USAGE_CACHE_TTL_MS,
  type UsageCacheIo,
} from "../plan-usage-remaining/telemetry-core/cache.ts";
import {
  buildUsageLogRows,
  getBoundedForecastSamples,
  parseUsageLog,
  readUsageLogRaw,
  realAppendUsageLog,
  type UsageLogRow,
} from "../plan-usage-remaining/telemetry-core/log.ts";
import { forecastUsageAtReset } from "../plan-usage-remaining/telemetry-core/forecast.ts";
import type { UsageWindow } from "../plan-usage-remaining/telemetry.types.ts";
import { errorText } from "../shared-policy/error-text.ts";

export const OPENCODE_GO_PROVIDER = "opencode-go" as const;
const DASHBOARD_BASE_URL = "https://opencode.ai/workspace";

export interface OpenCodeGoUsagePayload {
  source: "api" | "error";
  provider: typeof OPENCODE_GO_PROVIDER;
  harness: typeof OPENCODE_GO_PROVIDER;
  as_of: string;
  windows?: UsageWindow[];
  error?: string;
  stale?: boolean;
}

export interface OpenCodeGoUsageDeps {
  workspaceId: () => string | undefined;
  authCookie: () => string | undefined;
  fetchDashboard: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<{ status: number; text: string }>;
  now: () => Date;
  out: (line: string) => void;
  errOut: (line: string) => void;
  cacheIo?: UsageCacheIo;
  appendUsageLog?: (rows: UsageLogRow[]) => Promise<void>;
  readUsageLog?: () => Promise<string>;
}

function environmentValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export const REAL_OPENCODE_GO_USAGE_DEPS: OpenCodeGoUsageDeps = {
  workspaceId: () =>
    environmentValue(
      "OMNIROUTE_OPENCODE_GO_WORKSPACE_ID",
      "OPENCODE_GO_WORKSPACE_ID",
    ),
  authCookie: () =>
    environmentValue(
      "OMNIROUTE_OPENCODE_GO_AUTH_COOKIE",
      "OPENCODE_GO_AUTH_COOKIE",
    ),
  fetchDashboard: async (url, headers) => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, text: await response.text() };
  },
  now: () => new Date(),
  out: (line) => process.stdout.write(line),
  errOut: (line) => process.stderr.write(line),
  cacheIo: realUsageCacheIo(OPENCODE_GO_PROVIDER),
  appendUsageLog: realAppendUsageLog(),
  readUsageLog: readUsageLogRaw,
};

function parseReset(value: string): number | null {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (["reset-now", "reset now", "now", "resets now"].includes(text)) return 0;
  let seconds = 0;
  let found = false;
  for (const [pattern, multiplier] of [
    [/(\d+(?:\.\d+)?)\s*days?/, 86400],
    [/(\d+(?:\.\d+)?)\s*hours?/, 3600],
    [/(\d+(?:\.\d+)?)\s*minutes?/, 60],
    [/(\d+(?:\.\d+)?)\s*seconds?/, 1],
  ] as const) {
    const match = text.match(pattern);
    if (match) {
      seconds += Number(match[1]) * multiplier;
      found = true;
    }
  }
  return found ? seconds : null;
}

interface DashboardWindow {
  usedPercent: number;
  resetInSeconds: number;
}

function fromObservation(
  capWindow: string,
  observation: DashboardWindow,
  now: Date,
): UsageWindow | undefined {
  if (observation.usedPercent < 0 || observation.usedPercent > 100)
    return undefined;
  const window: UsageWindow = {
    cap_window: capWindow,
    used_pct: observation.usedPercent,
    remaining_pct: 100 - observation.usedPercent,
  };
  if (
    Number.isFinite(observation.resetInSeconds) &&
    observation.resetInSeconds >= 0
  ) {
    window.reset_time = new Date(
      now.getTime() + observation.resetInSeconds * 1000,
    ).toISOString();
  }
  return window;
}

function ssrWindow(html: string, field: string): DashboardWindow | undefined {
  const number = "(-?\\d+(?:\\.\\d+)?)";
  const patterns: ReadonlyArray<[RegExp, number, number]> = [
    [
      new RegExp(
        `${field}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${number}[^}]*resetInSec:${number}[^}]*\\}`,
      ),
      1,
      2,
    ],
    [
      new RegExp(
        `${field}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${number}[^}]*usagePercent:${number}[^}]*\\}`,
      ),
      2,
      1,
    ],
  ];
  for (const [pattern, usageIndex, resetIndex] of patterns) {
    const match = pattern.exec(html);
    if (match)
      return {
        usedPercent: Number(match[usageIndex]),
        resetInSeconds: Number(match[resetIndex]),
      };
  }
  return undefined;
}

export function parseOpenCodeGoDashboard(
  html: string,
  now: Date,
): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [label, field] of [
    ["5h", "rollingUsage"],
    ["weekly", "weeklyUsage"],
    ["monthly", "monthlyUsage"],
  ] as const) {
    const observation = ssrWindow(html, field);
    const window = observation && fromObservation(label, observation, now);
    if (window) windows.push(window);
  }
  if (windows.length) return windows;
  for (const content of html.split(/data-slot="usage-item"/).slice(1)) {
    const label = content
      .match(/data-slot="usage-label">([^<]+)</)?.[1]
      ?.trim()
      .toLowerCase();
    const usedPercent = Number(
      content.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/)?.[1],
    );
    const reset = content.match(
      /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/,
    );
    if (!label || !Number.isFinite(usedPercent) || !reset) continue;
    const resetInSeconds =
      reset[1] === "reset-now"
        ? 0
        : parseReset(
            reset[2]
              .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
              .replace(/Resets?\s*in\s*/i, ""),
          );
    const capWindow = label.includes("rolling")
      ? "5h"
      : label.includes("weekly")
        ? "weekly"
        : label.includes("monthly")
          ? "monthly"
          : undefined;
    const window =
      capWindow && resetInSeconds !== null
        ? fromObservation(capWindow, { usedPercent, resetInSeconds }, now)
        : undefined;
    if (window) windows.push(window);
  }
  return windows;
}

export class OpenCodeGoUsageService {
  async getUsagePayload(
    deps: OpenCodeGoUsageDeps = REAL_OPENCODE_GO_USAGE_DEPS,
  ): Promise<OpenCodeGoUsagePayload> {
    const payload = deps.cacheIo
      ? await cachedUsage(
          () => this.fetch(deps),
          deps.cacheIo,
          USAGE_CACHE_TTL_MS,
        )
      : await this.fetch(deps);
    if (payload.source === "api" && payload.windows && deps.readUsageLog) {
      const rows = parseUsageLog(await deps.readUsageLog());
      const now = deps.now();
      for (const window of payload.windows) {
        const samples = getBoundedForecastSamples(
          rows,
          OPENCODE_GO_PROVIDER,
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
          reset_time: window.reset_time ?? "",
          samples,
        }).projected_remaining_pct;
      }
    }
    if (deps.appendUsageLog) {
      const rows = buildUsageLogRows(payload, deps.now().toISOString());
      if (rows.length) await deps.appendUsageLog(rows).catch(() => undefined);
    }
    return payload;
  }

  async run(
    args: string[],
    deps: OpenCodeGoUsageDeps = REAL_OPENCODE_GO_USAGE_DEPS,
  ): Promise<number> {
    const payload = await this.getUsagePayload(deps);
    if (args.includes("--json")) deps.out(`${JSON.stringify(payload)}\n`);
    else if (payload.source === "api")
      for (const window of payload.windows ?? [])
        deps.out(
          `${window.cap_window}: ${window.remaining_pct}% remaining (resets ${window.reset_time ?? "unknown"})\n`,
        );
    else deps.errOut(`opencode-go-usage-remaining: ${payload.error}\n`);
    return payload.source === "api" ? 0 : 1;
  }

  private async fetch(
    deps: OpenCodeGoUsageDeps,
  ): Promise<OpenCodeGoUsagePayload> {
    const now = deps.now();
    try {
      const workspaceId = deps.workspaceId()?.trim();
      const authCookie = deps.authCookie()?.trim();
      if (!workspaceId || !authCookie)
        throw new Error(
          "OpenCode Go usage unavailable: set OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE; the API key cannot read quota",
        );
      const response = await deps.fetchDashboard(
        `${DASHBOARD_BASE_URL}/${encodeURIComponent(workspaceId)}/go`,
        {
          Accept: "text/html",
          Cookie: `auth=${authCookie.replace(/^auth=/i, "")}`,
          "User-Agent": "Mozilla/5.0 Gecko/20100101 Firefox/152.0",
        },
      );
      if (response.status !== 200)
        throw new Error(
          `OpenCode Go dashboard request failed (HTTP ${response.status})`,
        );
      const windows = parseOpenCodeGoDashboard(response.text, now);
      if (!windows.length)
        throw new Error(
          "OpenCode Go dashboard response contained no readable usage windows",
        );
      return {
        source: "api",
        provider: OPENCODE_GO_PROVIDER,
        harness: OPENCODE_GO_PROVIDER,
        as_of: now.toISOString(),
        windows,
      };
    } catch (error) {
      return {
        source: "error",
        provider: OPENCODE_GO_PROVIDER,
        harness: OPENCODE_GO_PROVIDER,
        as_of: now.toISOString(),
        error: errorText(error),
      };
    }
  }
}
