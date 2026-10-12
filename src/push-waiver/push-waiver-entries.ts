import { parseFileLine, type FileLine } from "./file-line.ts";
import type { Finding } from "./push-waiver-findings.ts";
import { PushWaiverRefusal } from "./push-waiver-refusal.ts";

export const PushWaiverReason = {
  OtherOpenPr: "other-open-pr",
  AlreadyOnBase: "already-on-base",
  FindingWrong: "finding-wrong",
} as const;

export type PushWaiverReason = (typeof PushWaiverReason)[keyof typeof PushWaiverReason];

const ALLOWED_REASONS: readonly string[] = Object.values(PushWaiverReason);

export type WaiverEntry =
  | {
      readonly finding: number;
      readonly reason: typeof PushWaiverReason.OtherOpenPr;
      readonly pr: number;
      readonly commit: string;
      readonly location: FileLine;
    }
  | {
      readonly finding: number;
      readonly reason: typeof PushWaiverReason.AlreadyOnBase;
      readonly commit: string;
      readonly location: FileLine;
    }
  | {
      readonly finding: number;
      readonly reason: typeof PushWaiverReason.FindingWrong;
      readonly location: FileLine;
    }
  | {
      readonly finding: number;
      readonly reason: typeof PushWaiverReason.FindingWrong;
      readonly test: string;
    };

export interface WaivedFinding {
  readonly finding: Finding;
  readonly entry: WaiverEntry;
}

type EntryFields = Record<string, unknown>;

function isPositiveWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPushWaiverReason(value: unknown): value is PushWaiverReason {
  return typeof value === "string" && ALLOWED_REASONS.includes(value);
}

function requireText(fields: EntryFields, name: string, label: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PushWaiverRefusal(`${label} has empty evidence: "${name}" must be given.`);
  }
  return value.trim();
}

function requireLocation(fields: EntryFields, label: string): FileLine {
  const text = requireText(fields, "location", label);
  const location = parseFileLine(text);
  if (location === undefined) {
    throw new PushWaiverRefusal(`${label} has a malformed location "${text}": expected path:line.`);
  }
  return location;
}

function requirePullRequestNumber(fields: EntryFields, label: string): number {
  if (!isPositiveWholeNumber(fields.pr)) {
    throw new PushWaiverRefusal(`${label} has empty or malformed evidence: "pr" must be the other pull request's number.`);
  }
  return fields.pr;
}

function readEntry(value: unknown, position: number): WaiverEntry {
  const fields: EntryFields = typeof value === "object" && value !== null ? (value as EntryFields) : {};
  if (!isPositiveWholeNumber(fields.finding)) {
    throw new PushWaiverRefusal(`entry ${position} must name its finding by number ("finding": 1 for the first).`);
  }
  const finding = fields.finding;
  const label = `the entry for finding ${finding}`;
  if (!isPushWaiverReason(fields.reason)) {
    throw new PushWaiverRefusal(
      `${label} gives the reason "${String(fields.reason)}", which is not allowed; the reason must be one of: ${ALLOWED_REASONS.join(", ")}.`,
    );
  }
  switch (fields.reason) {
    case PushWaiverReason.OtherOpenPr:
      return {
        finding,
        reason: fields.reason,
        pr: requirePullRequestNumber(fields, label),
        commit: requireText(fields, "commit", label),
        location: requireLocation(fields, label),
      };
    case PushWaiverReason.AlreadyOnBase:
      return { finding, reason: fields.reason, commit: requireText(fields, "commit", label), location: requireLocation(fields, label) };
    case PushWaiverReason.FindingWrong:
      return fields.location === undefined
        ? { finding, reason: fields.reason, test: requireText(fields, "test", label) }
        : { finding, reason: fields.reason, location: requireLocation(fields, label) };
  }
}

export function readEntries(text: string): WaiverEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PushWaiverRefusal(`entries file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new PushWaiverRefusal("entries file must be a JSON array with one entry per finding.");
  }
  return parsed.map((value, index) => readEntry(value, index + 1));
}

export function pairEntriesWithFindings(findings: readonly Finding[], entries: readonly WaiverEntry[]): WaivedFinding[] {
  const entriesByFinding = new Map<number, WaiverEntry>();
  for (const entry of entries) {
    if (entry.finding > findings.length) {
      throw new PushWaiverRefusal(`an entry names finding ${entry.finding}, but the findings file holds only ${findings.length}.`);
    }
    if (entriesByFinding.has(entry.finding)) {
      throw new PushWaiverRefusal(`finding ${entry.finding} has more than one entry; give exactly one.`);
    }
    entriesByFinding.set(entry.finding, entry);
  }
  return findings.map((finding) => {
    const entry = entriesByFinding.get(finding.number);
    if (entry === undefined) {
      throw new PushWaiverRefusal(
        `finding ${finding.number} (${finding.severity} ${finding.location} ${finding.title}) has no entry; every finding needs one.`,
      );
    }
    return { finding, entry };
  });
}
