import type { AccountUsage } from './plan-usage-accounts.ts';
import { USAGE_READING_SOURCES, type UsagePayload, type UsageWindow } from './telemetry.types.ts';

const JSON_FLAG = '--json';

function isReusedReading(payload: UsagePayload): boolean {
  return payload.reading_source !== undefined && payload.reading_source !== USAGE_READING_SOURCES.FRESH;
}

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

  private formatReadableUsage(payload: UsagePayload): string {
    const reuseNote = isReusedReading(payload) ? ` (${payload.reading_source}, read ${payload.as_of})` : '';
    return `${this.formatHumanUsage(payload.windows ?? [])}${reuseNote}`;
  }

  private formatAccountUsage(account: AccountUsage): string {
    if (account.usage === undefined) return `${account.name}: logged out, no usage reading`;
    if (account.usage.source === 'error') return `${account.name}: usage unreadable — ${account.usage.error}`;
    return `${account.name}: ${this.formatReadableUsage(account.usage)}`;
  }

  commandResult(args: string[], payload: UsagePayload): UsageCommandResult {
    if (args.includes(JSON_FLAG)) {
      return { exitCode: payload.source === 'api' ? 0 : 1, stdout: `${JSON.stringify(payload)}\n` };
    }
    if (payload.source === 'error') {
      return { exitCode: 1, stderr: `plan-usage-remaining: ${payload.error}\n` };
    }
    return { exitCode: 0, stdout: `${this.formatReadableUsage(payload)}\n` };
  }

  accountsCommandResult(args: string[], primaryPayload: UsagePayload, accounts: AccountUsage[]): UsageCommandResult {
    if (args.includes(JSON_FLAG)) {
      return {
        exitCode: primaryPayload.source === 'api' ? 0 : 1,
        stdout: `${JSON.stringify({ ...primaryPayload, accounts })}\n`,
      };
    }
    return {
      exitCode: primaryPayload.source === 'error' ? 1 : 0,
      stdout: `${accounts.map((account) => this.formatAccountUsage(account)).join('\n')}\n`,
    };
  }
}
