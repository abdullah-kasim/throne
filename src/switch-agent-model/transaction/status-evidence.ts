import { effortToken, type Harness } from '../../harness-routing/harness.ts';

const EFFORT_LABELS: readonly string[] = [
  'effort',
  'reasoning effort',
  'thinking effort',
  'model reasoning effort',
];

function labelAndValue(line: string): { label: string; value: string } | null {
  const separator = line.indexOf(':');
  if (separator < 0) {
    return null;
  }
  const label = line
    .slice(0, separator)
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const value = line.slice(separator + 1).trim();
  return label === '' || value === '' ? null : { label, value };
}

export function parseStatusEffort(status: string): string | undefined {
  for (const line of status.split('\n')) {
    const parsed = labelAndValue(line);
    if (parsed !== null && EFFORT_LABELS.includes(parsed.label)) {
      return parsed.value;
    }
  }
  return undefined;
}

const FOREIGN_EVIDENCE_TOKENS = new Set([
  'except',
  'expected',
  'foreign',
  'instead',
  'no',
  'non',
  'not',
  'or',
  'previous',
  'requested',
  'target',
  'versus',
  'vs',
  'without',
]);

interface EvidenceToken {
  value: string;
  start: number;
  end: number;
}

function evidenceTokens(value: string): EvidenceToken[] {
  return [...value.toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function displayedEvidenceMatches(displayed: string, expected: string): boolean {
  const shown = evidenceTokens(displayed);
  const wanted = evidenceTokens(expected).map((token) => token.value);
  if (wanted.length === 0 || shown.some((token) => FOREIGN_EVIDENCE_TOKENS.has(token.value))) {
    return false;
  }
  const matches: number[] = [];
  for (let index = 0; index <= shown.length - wanted.length; index += 1) {
    if (wanted.every((value, offset) => shown[index + offset]?.value === value)) {
      matches.push(index);
    }
  }
  if (matches.length !== 1) {
    return false;
  }
  const first = shown[matches[0]!]!;
  const last = shown[matches[0]! + wanted.length - 1]!;
  return displayed[first.start - 1] !== '-' && displayed[last.end] !== '-';
}

function canonicalClaudeParentheticalMatches(displayed: string, expected: string): boolean {
  if (!['fable', 'opus', 'sonnet', 'haiku'].includes(expected)) return false;
  const match = displayed.trim().toLowerCase().match(/^([a-z0-9]+) \(([^()]+)\)$/);
  if (match === null || match[1] !== expected) return false;
  const prefix = `claude-${expected}-`;
  return match[2]!.startsWith(prefix) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(match[2]!.slice(prefix.length));
}

export function statusModelMatches(displayed: string, model: string): boolean {
  const expected = model.trim().toLowerCase();
  if (/^[a-z0-9]+ \([^()]+\)$/i.test(displayed.trim())) {
    return canonicalClaudeParentheticalMatches(displayed, expected);
  }
  return displayedEvidenceMatches(displayed, expected);
}

export function statusEffortMatches(
  displayed: string,
  harness: Harness,
  effort: number,
): boolean {
  return displayedEvidenceMatches(displayed, effortToken(harness, effort));
}
