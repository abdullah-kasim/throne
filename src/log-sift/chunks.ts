export const LINES_PER_CHUNK = 40;
export const LINES_SHARED_BY_NEIGHBOURING_CHUNKS = 5;

export interface LineChunk {
  readonly firstLineNumber: number;
  readonly lastLineNumber: number;
  readonly text: string;
}

export function overlappingChunks(lines: readonly string[]): readonly LineChunk[] {
  const chunks: LineChunk[] = [];
  const stride = LINES_PER_CHUNK - LINES_SHARED_BY_NEIGHBOURING_CHUNKS;
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + LINES_PER_CHUNK, lines.length);
    chunks.push({
      firstLineNumber: start + 1,
      lastLineNumber: end,
      text: lines.slice(start, end).join('\n'),
    });
    if (end === lines.length) break;
  }
  return chunks;
}

export function keptLineNumbers(
  keptChunks: readonly LineChunk[],
): ReadonlySet<number> {
  const lineNumbers = new Set<number>();
  for (const chunk of keptChunks) {
    for (
      let lineNumber = chunk.firstLineNumber;
      lineNumber <= chunk.lastLineNumber;
      lineNumber += 1
    ) {
      lineNumbers.add(lineNumber);
    }
  }
  return lineNumbers;
}

export function renderedKeptLines(
  lines: readonly string[],
  lineNumbersToKeep: ReadonlySet<number>,
): string {
  const numberWidth = String(lines.length).length;
  let rendered = '';
  let previousKeptLineNumber = 0;
  for (const lineNumber of [...lineNumbersToKeep].sort((a, b) => a - b)) {
    if (previousKeptLineNumber !== 0 && lineNumber !== previousKeptLineNumber + 1) {
      rendered += '...\n';
    }
    rendered += `${String(lineNumber).padStart(numberWidth)}: ${lines[lineNumber - 1] ?? ''}\n`;
    previousKeptLineNumber = lineNumber;
  }
  return rendered;
}
