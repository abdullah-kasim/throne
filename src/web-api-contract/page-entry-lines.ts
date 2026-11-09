const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.*)$/;

export const SECTION_HEADING_LEVEL = 2;
export const ENTRY_HEADING_LEVEL = 3;

export function headingLevelOf(line: string): number | undefined {
  return HEADING_PATTERN.exec(line)?.[1].length;
}

export function headingTextOf(line: string): string {
  return HEADING_PATTERN.exec(line)?.[2].trim() ?? "";
}

export function startsSectionOrEntry(line: string): boolean {
  const level = headingLevelOf(line);
  return level === SECTION_HEADING_LEVEL || level === ENTRY_HEADING_LEVEL;
}

export function entryEnd(lines: readonly string[], start: number): number {
  let end = start + 1;
  for (let position = start + 1; position < lines.length && !startsSectionOrEntry(lines[position]); position += 1) {
    if (lines[position].trim() !== "") end = position + 1;
  }
  return end;
}
