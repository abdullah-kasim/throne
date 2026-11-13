import type { PullRequestRecords } from "@contract/where-i-stand.ts";

const MILLISECONDS_IN_A_MINUTE = 60000;
const MINUTES_IN_AN_HOUR = 60;
const LARGEST_AGE_IN_HOURS = 48;
const HOURS_IN_A_DAY = 24;

export function describeTime(time: Date): string {
  return time.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function describeAge(time: string, now: number): string {
  const minutes = Math.round((now - new Date(time).getTime()) / MILLISECONDS_IN_A_MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_IN_AN_HOUR) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / MINUTES_IN_AN_HOUR);
  if (hours < LARGEST_AGE_IN_HOURS) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / HOURS_IN_A_DAY)} days ago`;
}

function describeReadTime(records: PullRequestRecords, now: number): string {
  const readAt = new Date(records.read_at);
  if (Number.isNaN(readAt.getTime())) return "The pull request records did not say when they were read.";
  return `Pull requests read ${describeTime(readAt)}, ${describeAge(records.read_at, now)}.`;
}

export function describeRecordsTime(records: PullRequestRecords | undefined, failedAt: number | null, now: number): string {
  if (failedAt === null) return records === undefined ? "Fetching the pull request records." : describeReadTime(records, now);
  const problem = `Could not fetch the pull request records at ${describeTime(new Date(failedAt))}.`;
  return records === undefined ? problem : `${problem} Showing what was last fetched. ${describeReadTime(records, now)}`;
}

const HOURS_BEFORE_THE_DAY_IS_NAMED = 12;
const DAYS_IN_A_WEEK = 7;
const DAYS_IN_A_MONTH = 30;
const WEEKS_BEFORE_MONTHS = 5;
const MONTHS_ARCHIVED_ROWS_ARE_KEPT = 6;

export const AgeGroup = { Today: "Today", Yesterday: "Yesterday", EarlierThisWeek: "Earlier this week", Older: "Older" } as const;

export type AgeGroup = (typeof AgeGroup)[keyof typeof AgeGroup];

export const AGE_GROUPS_IN_ORDER: readonly AgeGroup[] = [AgeGroup.Today, AgeGroup.Yesterday, AgeGroup.EarlierThisWeek, AgeGroup.Older];

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

function calendarDaysBetween(time: Date, now: number): number {
  const startOfDay = (moment: Date) => new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
  return Math.round((startOfDay(new Date(now)) - startOfDay(time)) / (HOURS_IN_A_DAY * MINUTES_IN_AN_HOUR * MILLISECONDS_IN_A_MINUTE));
}

export function describeRowAge(time: string, now: number): string {
  const moment = new Date(time);
  const minutes = Math.floor((now - moment.getTime()) / MILLISECONDS_IN_A_MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_IN_AN_HOUR) return plural(minutes, "minute");
  const hours = Math.floor(minutes / MINUTES_IN_AN_HOUR);
  if (hours < HOURS_BEFORE_THE_DAY_IS_NAMED) return plural(hours, "hour");
  const days = calendarDaysBetween(moment, now);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < DAYS_IN_A_WEEK) return plural(days, "day");
  if (days < WEEKS_BEFORE_MONTHS * DAYS_IN_A_WEEK) return plural(Math.floor(days / DAYS_IN_A_WEEK), "week");
  return plural(Math.max(1, Math.floor(days / DAYS_IN_A_MONTH)), "month");
}

export function ageGroupOf(time: string, now: number): AgeGroup {
  const days = calendarDaysBetween(new Date(time), now);
  if (days <= 0) return AgeGroup.Today;
  if (days === 1) return AgeGroup.Yesterday;
  return days < DAYS_IN_A_WEEK ? AgeGroup.EarlierThisWeek : AgeGroup.Older;
}

export function deletionMonthOf(archivedAt: string): string {
  const deletion = new Date(archivedAt);
  deletion.setMonth(deletion.getMonth() + MONTHS_ARCHIVED_ROWS_ARE_KEPT);
  return deletion.toLocaleString(undefined, { month: "long", year: "numeric" });
}
