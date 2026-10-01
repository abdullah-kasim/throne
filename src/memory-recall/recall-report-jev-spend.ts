import { localDate } from '../relevance-classifier/jev-budget.ts';
import {
  JEV_USAGE_LOG_FILE_NAME,
  type JevCallerKind,
  type JevUsageLine,
  type JevUsageLog,
} from '../relevance-classifier/jev-usage-log.ts';

const ACCOUNT_USAGE_CROSS_CHECK =
  'The TypeSafe API does not expose the account\'s charged usage, so the TypeSafe console is the only cross-check of this spend.';

interface JevSpendOfDayAndCaller {
  readonly day: string;
  readonly caller: JevCallerKind;
  readonly sent: number;
  readonly failed: number;
  readonly estimatedTokensSent: number;
  readonly realTokens: number;
  readonly refusedForTheBudget: number;
  readonly notSentForABusyLock: number;
}

export function wasSent(line: JevUsageLine): boolean {
  return line.outcome === 'answered' || line.outcome === 'failed';
}

function spendOf(day: string, caller: JevCallerKind, lines: readonly JevUsageLine[]): JevSpendOfDayAndCaller {
  const sentLines = lines.filter(wasSent);
  return {
    day,
    caller,
    sent: sentLines.length,
    failed: lines.filter((line) => line.outcome === 'failed').length,
    estimatedTokensSent: sentLines.reduce((total, line) => total + line.estimatedTokens, 0),
    realTokens: lines.reduce((total, line) => total + (line.realTokens ?? 0), 0),
    refusedForTheBudget: lines.filter((line) => line.outcome === 'rate-limited').length,
    notSentForABusyLock: lines.filter((line) => line.outcome === 'lock-busy').length,
  };
}

export function jevSpendByDayAndCaller(lines: readonly JevUsageLine[]): readonly JevSpendOfDayAndCaller[] {
  const groups = new Map<string, { day: string; caller: JevCallerKind; lines: JevUsageLine[] }>();
  for (const line of lines) {
    const day = localDate(new Date(line.at));
    const key = `${day} ${line.caller}`;
    const group = groups.get(key) ?? { day, caller: line.caller, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => spendOf(group.day, group.caller, group.lines));
}

function tokenCount(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function renderedSpend(spend: JevSpendOfDayAndCaller): string {
  return `    ${spend.day} ${spend.caller}: ${spend.sent} requests sent (${spend.failed} failed), ${tokenCount(spend.estimatedTokensSent)} estimated tokens, ${tokenCount(spend.realTokens)} real tokens reported; ${spend.refusedForTheBudget} refused because the budget was used up, ${spend.notSentForABusyLock} not sent because the budget lock was busy`;
}

export function renderedJevSpendByDayAndCaller(usageLog: JevUsageLog): string {
  const spends = jevSpendByDayAndCaller(usageLog.lines);
  return [
    `Jev spend per local day and caller (from ${JEV_USAGE_LOG_FILE_NAME}):`,
    ...(spends.length === 0 ? ['    no Jev requests logged'] : spends.map(renderedSpend)),
    ...(usageLog.unreadableLineCount === 0
      ? []
      : [`    unreadable usage lines skipped: ${usageLog.unreadableLineCount}`]),
    `    ${ACCOUNT_USAGE_CROSS_CHECK}`,
    '',
  ].join('\n');
}
