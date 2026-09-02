export function splitLogicalLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}
