import type { RowFields } from "../web-api-contract/where-i-stand.ts";

const OPENING_LINES = [
  ["links", "- Links:"],
  ["workKind", "- Kind:"],
  ["whereItStands", "- Where it stands:"],
] as const;

function trimmedLinesOf(text: string): string[] {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const first = lines.findIndex((line) => line !== "");
  const last = lines.findLastIndex((line) => line !== "");
  return first === -1 ? [] : lines.slice(first, last + 1);
}

export function workFieldsOf(code: string, text: string): RowFields {
  const lines = trimmedLinesOf(text);
  const fields: RowFields = { kind: "work", code };
  let next = 0;
  for (const [field, opening] of OPENING_LINES) {
    if (lines[next]?.startsWith(opening) !== true) continue;
    fields[field] = lines[next].slice(opening.length).trim();
    next += 1;
  }
  const freeLines = lines.slice(next);
  return { ...fields, freeLines: freeLines.length === 0 ? undefined : freeLines };
}
