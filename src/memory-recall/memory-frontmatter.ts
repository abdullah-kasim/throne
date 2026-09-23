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

export function splitFrontmatterFromBody(text: string): SplitMemoryText {
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== FRONTMATTER_FENCE) {
    return { frontmatterLines: [], body: text };
  }
  const closingFenceIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === FRONTMATTER_FENCE,
  );
  if (closingFenceIndex === -1) return { frontmatterLines: [], body: text };
  const linesBetweenFences = lines
    .slice(1, closingFenceIndex)
    .map((line) => line.trimEnd());
  const everyLineIsAKeyOrBlank = linesBetweenFences.every(
    (line) => line.length === 0 || KEY_AND_VALUE.test(line),
  );
  if (!everyLineIsAKeyOrBlank) return { frontmatterLines: [], body: text };
  return {
    frontmatterLines: linesBetweenFences,
    body: lines.slice(closingFenceIndex + 1).join('\n'),
  };
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
