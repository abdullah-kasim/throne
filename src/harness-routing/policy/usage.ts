import {
  HARNESSES,
  HARNESS_NAMES,
  MODEL_NAMES,
  type Harness,
} from '../harness.ts';
import type { UsageWindow } from '../../plan-usage-remaining/telemetry.types.ts';

export const SESSION_FLOOR_PCT = 20;
export const CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT = 20;

export interface HarnessUsage {
  weeklyPct?: number;
  weeklyForecast?: number;
  sessionPct?: number;
  fableWeeklyPct?: number;
  fableWeeklyForecast?: number;
  ok: boolean;
}

export interface UsagePayloadLike {
  source: 'api' | 'error';
  windows?: UsageWindow[];
  stale?: boolean;
}

export interface RemainingComparison {
  preferred: 'left' | 'right' | 'tie';
  detail: string;
  leftBasisPct: number;
  rightBasisPct: number;
}

export type ShadowRoute =
  | { kind: 'route'; harness: Harness; reason: string; degraded: boolean }
  | { kind: 'pause'; reason: string }
  | { kind: 'no-signal'; reason: string };

function isFableScopedWeeklyWindow(window: UsageWindow): boolean {
  if (!window.cap_window.startsWith('weekly:')) return false;
  const scope = window.scope_model ?? window.cap_window.slice('weekly:'.length);
  return scope.toLowerCase() === MODEL_NAMES.FABLE;
}

export function readHarnessUsage(payload: UsagePayloadLike): HarnessUsage {
  if (
    payload.source !== 'api' ||
    payload.stale === true ||
    payload.windows === undefined
  ) {
    return { ok: false };
  }
  const weekly = payload.windows.find(
    (window) => window.cap_window === 'weekly',
  );
  if (weekly === undefined) {
    return { ok: false };
  }
  const session = payload.windows.find((window) => window.cap_window === '5h');
  const fableWeekly = payload.windows.find(isFableScopedWeeklyWindow);
  const usage: HarnessUsage = { weeklyPct: weekly.remaining_pct, ok: true };
  if (session !== undefined) {
    usage.sessionPct = session.remaining_pct;
  }
  if (fableWeekly !== undefined) {
    usage.fableWeeklyPct = fableWeekly.remaining_pct;
  }
  return usage;
}

export function isHarnessUsageUsable(usage: HarnessUsage): boolean {
  return (
    usage.ok &&
    usage.weeklyPct !== undefined &&
    usage.weeklyPct > 0 &&
    (usage.sessionPct === undefined || usage.sessionPct > 0)
  );
}

export function describeUnusableHarnessUsage(
  usage: HarnessUsage,
  floored: boolean,
): string {
  if (!usage.ok) return 'unavailable';
  if (floored) return `floored (${usage.sessionPct}% session)`;
  if (usage.weeklyPct !== undefined && usage.weeklyPct <= 0) {
    return `exhausted (${usage.weeklyPct}% weekly)`;
  }
  return `session-exhausted (${usage.sessionPct}% 5h)`;
}

function claudeSessionFloored(claude: HarnessUsage): boolean {
  return (
    claude.ok &&
    claude.sessionPct !== undefined &&
    claude.sessionPct <= SESSION_FLOOR_PCT
  );
}

function isClaudeUsableForShadow(claude: HarnessUsage): boolean {
  return isHarnessUsageUsable(claude) && !claudeSessionFloored(claude);
}

export function compareRemaining(
  left: HarnessUsage,
  right: HarnessUsage,
  leftForecast: number | undefined = left.weeklyForecast,
  rightForecast: number | undefined = right.weeklyForecast,
  leftCurrent: number | undefined = left.weeklyPct,
  rightCurrent: number | undefined = right.weeklyPct,
): RemainingComparison {
  if (leftForecast !== undefined && rightForecast !== undefined) {
    const preferred =
      leftForecast === rightForecast
        ? 'tie'
        : leftForecast > rightForecast
          ? 'left'
          : 'right';
    return {
      preferred,
      detail: `${leftForecast}% vs ${rightForecast}% projected at reset`,
      leftBasisPct: leftForecast,
      rightBasisPct: rightForecast,
    };
  }
  const preferred =
    leftCurrent === rightCurrent
      ? 'tie'
      : leftCurrent! > rightCurrent!
        ? 'left'
        : 'right';
  return {
    preferred,
    detail:
      `current remaining fallback: ${leftCurrent}% vs ${rightCurrent}% ` +
      `(sufficient forecasts unavailable)`,
    leftBasisPct: leftCurrent!,
    rightBasisPct: rightCurrent!,
  };
}

export function pickShadowHarness(
  claude: HarnessUsage,
  codex: HarnessUsage,
  allowedHarnesses: readonly Harness[] = HARNESSES,
): ShadowRoute {
  const claudeAllowed = allowedHarnesses.includes(HARNESS_NAMES.CLAUDE);
  const codexAllowed = allowedHarnesses.includes(HARNESS_NAMES.CODEX);
  const floored = claudeSessionFloored(claude);
  const usableClaude = claudeAllowed && isClaudeUsableForShadow(claude);
  const usableCodex = codexAllowed && isHarnessUsageUsable(codex);
  const degraded =
    (claudeAllowed && !claude.ok) || (codexAllowed && !codex.ok);

  if (usableClaude && usableCodex) {
    const comparison = compareRemaining(claude, codex);
    const claudeLead = comparison.leftBasisPct - comparison.rightBasisPct;
    const basis = `claude vs codex ${comparison.detail}`;
    if (claudeLead >= CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT) {
      return {
        kind: 'route',
        harness: HARNESS_NAMES.CLAUDE,
        reason:
          `claude preferred over codex — ${basis}; claude leads by ` +
          `${claudeLead} ≥ ${CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT}-point ` +
          `conservation threshold`,
        degraded,
      };
    }
    return {
      kind: 'route',
      harness: HARNESS_NAMES.CODEX,
      reason:
        `codex preferred over claude — ${basis}; claude lead ${claudeLead} < ` +
        `${CLAUDE_PROJECTION_LEAD_THRESHOLD_PCT}-point conservation threshold — ` +
        `conserving claude`,
      degraded,
    };
  }

  if (usableClaude) {
    const reason = codexAllowed
      ? `only claude usable (weekly ${claude.weeklyPct}%)`
      : `codex is excluded by the active role pool — ` +
        `routing to claude (weekly ${claude.weeklyPct}%)`;
    return { kind: 'route', harness: HARNESS_NAMES.CLAUDE, reason, degraded };
  }

  if (usableCodex) {
    const reason = !claudeAllowed
      ? `claude is excluded by the active role pool — routing to codex (weekly ${codex.weeklyPct}%)`
      : floored
        ? `claude floored at ${claude.sessionPct}% ≤ ${SESSION_FLOOR_PCT}% session — reserving Claude, routing to codex`
        : `only codex usable (weekly ${codex.weeklyPct}%)`;
    return { kind: 'route', harness: HARNESS_NAMES.CODEX, reason, degraded };
  }

  if (
    claudeAllowed &&
    !codexAllowed &&
    floored &&
    isHarnessUsageUsable(claude)
  ) {
    return {
      kind: 'route',
      harness: HARNESS_NAMES.CLAUDE,
      reason:
        `claude session-floored at ${claude.sessionPct}% ≤ ${SESSION_FLOOR_PCT}% but codex is ` +
        `excluded by the active role pool — the reservation has no ` +
        `fallback; routing to claude rather than halting`,
      degraded,
    };
  }

  const allowedReadings = [
    ...(claudeAllowed ? [claude] : []),
    ...(codexAllowed ? [codex] : []),
  ];
  if (
    allowedReadings.length > 0 &&
    allowedReadings.every((usage) => !usage.ok)
  ) {
    return {
      kind: 'no-signal',
      reason: 'every active-role-pool usage sensor is unavailable',
    };
  }

  const claudeClause = claudeAllowed
    ? `claude ${describeUnusableHarnessUsage(claude, floored)}`
    : 'claude excluded by the active role pool';
  const codexClause = codexAllowed
    ? `codex ${describeUnusableHarnessUsage(codex, false)}`
    : 'codex excluded by the active role pool';
  return {
    kind: 'pause',
    reason:
      `${claudeClause} and ${codexClause} — no admitted harness can take this ` +
      `Shadow; usage steering is mandatory`,
  };
}
