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
