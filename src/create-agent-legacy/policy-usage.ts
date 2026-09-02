import { readHarnessUsage } from "../harness-routing/policy/usage.ts";
import {
  getBoundedForecastSamples,
  parseUsageLog,
  type UsageLogRow,
} from "./legacy-usage-log.ts";
import { forecastUsageAtReset } from "../plan-usage-remaining/telemetry-core/forecast.ts";
import {
  isFableWeeklyReading,
  WEEKLY_CAP_WINDOW,
} from "../plan-usage-remaining/telemetry-core/weekly-reset.ts";
import type { UsagePayload } from "../plan-usage-remaining/telemetry.types.ts";
import type { CodexUsagePayload } from "../shared-policy/codex-usage.service.ts";
import {
  OPENCODE_GO_PROVIDER,
  type OpenCodeGoUsagePayload,
} from "../opencode-go-usage-remaining/opencode-go-usage.service.ts";
import type { CreateAgentDeps } from "./create.types.ts";
import { UsageReadersService } from "./legacy-usage-readers.service.ts";

export type UsagePolicyDeps = Pick<
  CreateAgentDeps,
  | "getClaudeUsage"
  | "getCodexUsage"
  | "getOpenCodeGoUsage"
  | "readUsageLogRaw"
  | "now"
>;

function usageIsoTime(deps: UsagePolicyDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}
export function buildHarnessUsage(
  payload: UsagePayload | CodexUsagePayload | OpenCodeGoUsagePayload,
  rows: readonly UsageLogRow[] | undefined,
  now: string,
) {
  const usage = readHarnessUsage(payload);
  if (
    rows === undefined ||
    !usage.ok ||
    payload.source !== "api" ||
    payload.windows === undefined
  ) {
    return usage;
  }
  const nowDate = new Date(now);
  const forecastWindow = (capWindow: string) => {
    const window = payload.windows?.find(
      (candidate) => candidate.cap_window === capWindow,
    );
    if (window?.reset_time === undefined) return undefined;
    const result = forecastUsageAtReset({
      now,
      reset_time: window.reset_time,
      samples: getBoundedForecastSamples(
        rows,
        payload.harness,
        capWindow,
        nowDate,
      ),
    });
    return result.projected_remaining_pct ?? undefined;
  };
  usage.weeklyForecast = forecastWindow(WEEKLY_CAP_WINDOW);
  const fableWindow = payload.windows.find(isFableWeeklyReading);
  if (fableWindow !== undefined) {
    usage.fableWeeklyForecast = forecastWindow(fableWindow.cap_window);
  }
  return usage;
}

export function usageReaders(deps: UsagePolicyDeps) {
  return new UsageReadersService(deps);
}

export async function buildOpenCodeGoCanaryUsage(
  readers: ReturnType<typeof usageReaders>,
  deps: UsagePolicyDeps,
) {
  return buildHarnessUsage(
    await readers.opencodeGo(),
    undefined,
    usageIsoTime(deps),
  );
}

export async function buildRoutingUsage(
  readers: ReturnType<typeof usageReaders>,
  deps: UsagePolicyDeps,
) {
  const [claude, codex, opencodeGo] = await Promise.all([
    readers.claude(),
    readers.codex(),
    readers.opencodeGo(),
  ]);
  const now = usageIsoTime(deps);
  const rows = await (deps.readUsageLogRaw?.() ?? Promise.resolve(""))
    .then(parseUsageLog)
    .catch(() => []);
  return {
    claude: buildHarnessUsage(claude, rows, now),
    codex: buildHarnessUsage(codex, rows, now),
    opencode: buildHarnessUsage(opencodeGo, undefined, now),
  };
}
