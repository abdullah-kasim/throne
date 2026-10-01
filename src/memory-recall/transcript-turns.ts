import { readFile } from 'node:fs/promises';

const ASSISTANT_ENTRY = 'assistant';
const TEXT_BLOCK = 'text';
const TOOL_USE_BLOCK = 'tool_use';

interface TranscriptBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

interface TranscriptEntry {
  readonly type?: unknown;
  readonly timestamp?: unknown;
  readonly message?: { readonly id?: unknown; readonly content?: unknown };
}

function parsedEntry(line: string): TranscriptEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TranscriptEntry) : undefined;
  } catch {
    return undefined;
  }
}

function isAssistantEntryAfter(entry: TranscriptEntry, after: number): boolean {
  return (
    entry.type === ASSISTANT_ENTRY &&
    typeof entry.timestamp === 'string' &&
    Date.parse(entry.timestamp) > after
  );
}

function blocksOf(entry: TranscriptEntry): readonly TranscriptBlock[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? (content as TranscriptBlock[]) : [];
}

function textOfBlock(block: TranscriptBlock): string | undefined {
  if (block.type === TEXT_BLOCK && typeof block.text === 'string') return block.text;
  if (block.type === TOOL_USE_BLOCK) return `${String(block.name)} ${JSON.stringify(block.input)}`;
  return undefined;
}

function turnIdOf(entry: TranscriptEntry, index: number): string {
  return typeof entry.message?.id === 'string' ? entry.message.id : `entry-${index}`;
}

export async function assistantTurnsAfter(
  transcriptPath: string,
  after: string,
  turnCount: number,
): Promise<readonly string[] | undefined> {
  let text: string;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
  const afterTime = Date.parse(after);
  const turns = new Map<string, string[]>();
  text.split('\n').forEach((line, index) => {
    const entry = parsedEntry(line);
    if (entry === undefined || !isAssistantEntryAfter(entry, afterTime)) return;
    const turnId = turnIdOf(entry, index);
    if (!turns.has(turnId) && turns.size === turnCount) return;
    const parts = turns.get(turnId) ?? [];
    parts.push(...blocksOf(entry).flatMap((block) => textOfBlock(block) ?? []));
    turns.set(turnId, parts);
  });
  return [...turns.values()].map((parts) => parts.join('\n'));
}
