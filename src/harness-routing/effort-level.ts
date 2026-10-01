import { effortScoreForToken } from "./harness.ts";

export const EFFORT_LEVEL_NAMES: Readonly<Record<string, number>> = Object.fromEntries(
  ["low", "medium", "high", "xhigh", "max"].map((name) => [name, effortScoreForToken("claude", name)]),
);

export function effortLevelName(effort: number): string | undefined {
  return Object.keys(EFFORT_LEVEL_NAMES).find(
    (name) => EFFORT_LEVEL_NAMES[name] === effort,
  );
}

export function parseQueueEffort(raw: string | undefined): number {
  const value = (raw ?? "").trim().toLowerCase();
  const named = EFFORT_LEVEL_NAMES[value];
  if (named !== undefined) return named;
  if (/^[1-6]$/.test(value)) return Number(value);
  throw new Error(
    `--effort "${raw ?? ""}" is not an effort: use a number from 1 to 6 or one of ${Object.keys(EFFORT_LEVEL_NAMES).join(", ")}`,
  );
}
