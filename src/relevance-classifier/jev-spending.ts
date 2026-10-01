import { readJevSpend, type JevLimits, type JevSpend } from './jev-budget.ts';
import { readJevUsageLines } from './jev-usage-log.ts';
import { jevDataHomeOfThisMachine } from './jev-data-home.ts';
import { jevLimitsOf, type RecallConfig } from './recall-user-config.ts';

export interface JevSpending {
  readonly spend: JevSpend;
  readonly limits: JevLimits;
  readonly lockBusyRequestsToday: number;
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export async function readJevSpending(dataHome: string, limits: JevLimits, now: Date): Promise<JevSpending> {
  const [spend, usageToday] = await Promise.all([
    readJevSpend(dataHome, now),
    readJevUsageLines(dataHome, startOfLocalDay(now)),
  ]);
  return {
    spend,
    limits,
    lockBusyRequestsToday: usageToday.lines.filter((line) => line.outcome === 'lock-busy').length,
  };
}

export function readJevSpendingOnThisMachine(config: RecallConfig): Promise<JevSpending> {
  return readJevSpending(jevDataHomeOfThisMachine(), jevLimitsOf(config), new Date());
}

function tokenCount(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function spentOutOfLimit(spentTokens: number, limitTokens: number): string {
  return `${tokenCount(spentTokens)} of ${tokenCount(limitTokens)} (${tokenCount(Math.max(0, limitTokens - spentTokens))} left)`;
}

export function renderedJevSpending(spending: JevSpending): readonly string[] {
  return [
    `Jev tokens today: ${spentOutOfLimit(spending.spend.todayTokens, spending.limits.tokensPerDay)}`,
    `Jev tokens in the last hour: ${spentOutOfLimit(spending.spend.lastHourTokens, spending.limits.tokensPerHour)}`,
    `Jev requests not sent today because the budget lock was busy: ${spending.lockBusyRequestsToday}`,
  ];
}
