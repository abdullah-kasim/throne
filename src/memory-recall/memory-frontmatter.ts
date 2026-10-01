import {
  COSTS_IF_MISSED,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryFrontmatter,
} from './memory-frontmatter.types.ts';

const FRONTMATTER_FENCE = '---';
const KEY_AND_VALUE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;
const KEYS_READ_WHEN_NESTED = new Set(['type']);

export interface SplitMemoryText {
  readonly frontmatterLines: readonly string[];
  readonly body: string;
}

function closingFenceIndexOf(lines: readonly string[]): number | undefined {
  if (lines[0]?.trimEnd() !== FRONTMATTER_FENCE) return undefined;
  const closingFenceIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === FRONTMATTER_FENCE,
  );
  if (closingFenceIndex === -1) return undefined;
  const everyLineIsAKeyOrBlank = lines
    .slice(1, closingFenceIndex)
    .map((line) => line.trimEnd())
    .every((line) => line.length === 0 || KEY_AND_VALUE.test(line));
  return everyLineIsAKeyOrBlank ? closingFenceIndex : undefined;
}

export function splitFrontmatterFromBody(text: string): SplitMemoryText {
  const lines = text.split('\n');
  const closingFenceIndex = closingFenceIndexOf(lines);
  if (closingFenceIndex === undefined) return { frontmatterLines: [], body: text };
  return {
    frontmatterLines: lines.slice(1, closingFenceIndex).map((line) => line.trimEnd()),
    body: lines.slice(closingFenceIndex + 1).join('\n'),
  };
}

function askLineOf(ask: string): string {
  const escapedAsk = ask.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `ask: "${escapedAsk}"`;
}

function isAskLine(line: string): boolean {
  const match = KEY_AND_VALUE.exec(line.trimEnd());
  return match !== null && match[1] === '' && match[2] === 'ask';
}

function carriageReturnOf(line: string): string {
  return line.endsWith('\r') ? '\r' : '';
}

export function withAskLine(fileText: string, ask: string): string {
  const lines = fileText.split('\n');
  const closingFenceIndex = closingFenceIndexOf(lines);
  if (closingFenceIndex === undefined) {
    return [FRONTMATTER_FENCE, askLineOf(ask), FRONTMATTER_FENCE, fileText].join('\n');
  }
  const askLineIndex = lines.findIndex(
    (line, index) => index > 0 && index < closingFenceIndex && isAskLine(line),
  );
  if (askLineIndex === -1) {
    const openingFence = lines[0] as string;
    return [openingFence, askLineOf(ask) + carriageReturnOf(openingFence), ...lines.slice(1)].join('\n');
  }
  const oldAskLine = lines[askLineIndex] as string;
  return lines.with(askLineIndex, askLineOf(ask) + carriageReturnOf(oldAskLine)).join('\n');
}

function withoutSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (
    trimmed.length >= 2 &&
    (first === '"' || first === "'") &&
    trimmed.endsWith(first)
  ) {
    const inner = trimmed.slice(1, -1);
    return first === '"'
      ? inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\')
      : inner.replaceAll("''", "'");
  }
  return trimmed;
}

function keyedValues(
  frontmatterLines: readonly string[],
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of frontmatterLines) {
    const match = KEY_AND_VALUE.exec(line);
    if (match === null) continue;
    const [, indentation, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) continue;
    if (indentation !== '' && !KEYS_READ_WHEN_NESTED.has(key)) continue;
    const value = withoutSurroundingQuotes(rawValue);
    if (value.length > 0 && !values.has(key)) values.set(key, value);
  }
  return values;
}

function memberOf<const Allowed extends readonly string[]>(
  allowed: Allowed,
  value: string | undefined,
): Allowed[number] | undefined {
  return value !== undefined && allowed.includes(value)
    ? (value as Allowed[number])
    : undefined;
}

function withoutUndefinedValues<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as T;
}

export function parseMemoryFrontmatter(
  frontmatterLines: readonly string[],
): MemoryFrontmatter {
  const values = keyedValues(frontmatterLines);
  return withoutUndefinedValues({
    ask: values.get('ask'),
    scope: values.get('scope'),
    kind: memberOf(MEMORY_KINDS, values.get('kind')),
    learned: values.get('learned'),
    status: memberOf(MEMORY_STATUSES, values.get('status')),
    superseded_by: values.get('superseded_by'),
    cost_if_missed: memberOf(COSTS_IF_MISSED, values.get('cost_if_missed')),
    name: values.get('name'),
    description: values.get('description'),
    type: values.get('type'),
  });
}
