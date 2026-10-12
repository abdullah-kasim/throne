import { parseArgs } from "node:util";

export const WORK_LOG_USAGE = "usage: throne work-log --since <date> [--json]";

export interface WorkLogArguments {
  readonly since: Date;
  readonly json: boolean;
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const BARE_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asLocalDateTime(value: string): string {
  return BARE_ISO_DATE.test(value) ? `${value}T00:00:00` : value;
}

export function parseSinceDate(value: string): Date {
  const since = new Date(asLocalDateTime(value));
  if (!ISO_DATE_PREFIX.test(value) || Number.isNaN(since.getTime())) {
    throw new Error(`--since "${value}" is not an ISO date (2026-10-06) or date-time (2026-10-06T09:00)`);
  }
  return since;
}

export function parseWorkLogArguments(commandArguments: readonly string[]): WorkLogArguments {
  const { values } = parseArgs({
    args: [...commandArguments],
    options: {
      since: { type: "string" },
      json: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.since === undefined) {
    throw new Error("--since <date> is required");
  }
  return { since: parseSinceDate(values.since), json: values.json };
}
