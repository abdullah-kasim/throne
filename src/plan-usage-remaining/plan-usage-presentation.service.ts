import type { UsagePayload, UsageWindow } from './telemetry.types.ts';

const JSON_FLAG = '--json';

export interface UsageCommandResult { exitCode: number; stdout?: string; stderr?: string; }

export class PlanUsagePresentationService {
  formatHumanUsage(windows: UsageWindow[]): string {
    if (windows.length === 0) return 'Claude plan usage: no cap windows reported.';
    const parts = windows.map((window) => {
      const current = `${window.cap_window}: ${window.remaining_pct}% remaining (resets ${window.reset_time ?? 'unknown'})`;
      if (window.projected_remaining_pct === undefined) return current;
      const projection = window.projected_remaining_pct === null
        ? 'projection unavailable'
        : `projected ${window.projected_remaining_pct.toFixed(1)}% remaining at reset`;
      return `${current}; ${projection}`;
    });
    return `Claude plan usage — ${parts.join(' · ')}`;
  }

  commandResult(args: string[], payload: UsagePayload): UsageCommandResult {
    if (args.includes(JSON_FLAG)) {
      return { exitCode: payload.source === 'api' ? 0 : 1, stdout: `${JSON.stringify(payload)}\n` };
    }
    if (payload.source === 'error') {
      return { exitCode: 1, stderr: `plan-usage-remaining: ${payload.error}\n` };
    }
    const staleNote = payload.stale ? ` (stale — last good ${payload.as_of})` : '';
    return { exitCode: 0, stdout: `${this.formatHumanUsage(payload.windows ?? [])}${staleNote}\n` };
  }
}
