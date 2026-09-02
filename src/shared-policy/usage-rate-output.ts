import type { RateResult, RateWindow } from './usagerate.ts';

function formatRate(rate: number | null): string {
  return rate === null ? '—' : rate.toFixed(2);
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function annotate(window: RateWindow): string {
  const resets = window.segment_count === 0 ? 0 : window.segment_count - 1;
  return `(${pluralize(window.reading_count, 'reading')}, ${pluralize(resets, 'reset')})`;
}

export function formatUsageRateHuman(anchor: string, results: RateResult[]): string[] {
  const header = `Usage burn rate — today / 7-day %/hour (today = current UTC day, anchored to newest reading ${anchor})`;
  const harnessWidth = Math.max(...results.map((result) => result.harness.length));
  const windowWidth = Math.max(...results.map((result) => result.cap_window.length));
  const todayWidth = Math.max(...results.map((result) => formatRate(result.today.pct_per_hour).length));
  const sevenWidth = Math.max(...results.map((result) => formatRate(result.seven_day.pct_per_hour).length));
  const lines = results.map((result) => {
    const harness = result.harness.padEnd(harnessWidth);
    const capWindow = result.cap_window.padEnd(windowWidth);
    const today = formatRate(result.today.pct_per_hour).padStart(todayWidth);
    const seven = formatRate(result.seven_day.pct_per_hour).padStart(sevenWidth);
    return `  ${harness}  ${capWindow}  today ${today}  ·  7-day ${seven}  ${annotate(result.seven_day)}`;
  });
  return [header, ...lines];
}
