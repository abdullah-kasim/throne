import { withPastedContentUnwrapped } from '../memory-recall/prompt-kind.ts';

export type DeliveryReceiptVerdict = 'intact' | 'truncated' | 'absent';

interface ClaudeTranscriptRecord {
  type?: unknown;
  isMeta?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
  attachment?: {
    type?: unknown;
    prompt?: unknown;
  };
}

function textOfContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const textBlocks = content.filter(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  );
  if (textBlocks.length === 0) return undefined;
  return textBlocks.map((block) => block.text).join('');
}

function deliveredTextOfRecord(record: ClaudeTranscriptRecord): string | undefined {
  if (record.type === 'attachment') {
    if (record.attachment?.type !== 'queued_command') return undefined;
    return textOfContent(record.attachment.prompt);
  }
  if (record.type !== 'user' || record.isMeta === true) return undefined;
  if (record.message?.role !== 'user') return undefined;
  return textOfContent(record.message.content);
}

export function deliveredTexts(transcript: string): string[] {
  const texts: string[] = [];
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch {
      continue;
    }
    const text = deliveredTextOfRecord(record);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

function withoutPasteTagsAndWhitespace(text: string): string {
  return withPastedContentUnwrapped(text).replace(/\s+/gu, '');
}

export function deliveredTextContains(deliveredText: string, typedText: string): boolean {
  return withoutPasteTagsAndWhitespace(deliveredText).includes(
    withoutPasteTagsAndWhitespace(typedText),
  );
}

export function deliveryReceiptVerdict(
  typedText: string,
  messageId: number,
  transcript: string,
): DeliveryReceiptVerdict {
  const messageNumber = `[message${messageId}]`;
  const textsCarryingTheMessage = deliveredTexts(transcript).filter((text) =>
    withoutPasteTagsAndWhitespace(text).includes(messageNumber),
  );
  if (textsCarryingTheMessage.length === 0) return 'absent';
  return textsCarryingTheMessage.some((text) => deliveredTextContains(text, typedText))
    ? 'intact'
    : 'truncated';
}
