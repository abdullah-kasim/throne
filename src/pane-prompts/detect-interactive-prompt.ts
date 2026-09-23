import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import {
  CLAUDE_INTERACTIVE_MENU_HINT,
  CLAUDE_PERMISSION_PROMPT_HINT,
  CLAUDE_PERMISSION_PROMPT_HINT_OFF_FIRST_ROW,
  claudeFrameHasInteractiveMenuHint,
} from '../codex-screen/composer/prompt-region.ts';
import { styledLinesFromAnsi } from '../codex-screen/composer/ansi.ts';
import { normalizeRenderedPayload } from '../codex-screen/composer/rendered-text.ts';

export const INTERACTIVE_PROMPT_KINDS = {
  PERMISSION: 'permission',
  QUESTION: 'question',
} as const;
export type InteractivePromptKind =
  (typeof INTERACTIVE_PROMPT_KINDS)[keyof typeof INTERACTIVE_PROMPT_KINDS];

export interface InteractivePromptOption {
  readonly number: number;
  readonly label: string;
}

export interface DetectedInteractivePrompt {
  readonly harness: typeof HARNESS_NAMES.CLAUDE | typeof HARNESS_NAMES.CODEX;
  readonly kind: InteractivePromptKind;
  readonly question: string;
  readonly command?: string;
  readonly warnings: readonly string[];
  readonly options: readonly InteractivePromptOption[];
  readonly selectedNumber: number | null;
  readonly hint: string;
}

export const SELECTED_OPTION_CURSOR = '❯';
const OPTION_ROW_PATTERN = /^\s*(❯)?\s*(\d+)\.\s+(.*\S)\s*$/u;
const BOX_SEPARATOR_PATTERN = /^\s*─{4,}\s*$/u;
const QUOTED_LINE_PATTERN = /^\s*│\s?(.*)$/u;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function normalizedLine(line: string): string {
  return normalizeRenderedPayload(line);
}

function lastLineIndexMatching(lines: readonly string[], hint: string): number {
  const wanted = normalizeRenderedPayload(hint);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (normalizedLine(lines[index]!) === wanted) return index;
  }
  return -1;
}

function lastNonBlankIndexBefore(lines: readonly string[], index: number): number {
  let cursor = index - 1;
  while (cursor >= 0 && isBlank(lines[cursor]!)) cursor -= 1;
  return cursor;
}

interface OptionBlock {
  readonly options: readonly InteractivePromptOption[];
  readonly selectedNumber: number | null;
  readonly firstLineIndex: number;
}

function readOptionBlockAbove(lines: readonly string[], hintIndex: number): OptionBlock | undefined {
  const lastIndex = lastNonBlankIndexBefore(lines, hintIndex);
  if (lastIndex < 0) return undefined;
  let firstIndex = lastIndex;
  while (firstIndex - 1 >= 0 && !isBlank(lines[firstIndex - 1]!)) firstIndex -= 1;
  const options: InteractivePromptOption[] = [];
  let selectedNumber: number | null = null;
  let firstOptionRowIndex = -1;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const match = OPTION_ROW_PATTERN.exec(lines[index]!);
    if (match === null) continue;
    if (firstOptionRowIndex < 0) firstOptionRowIndex = index;
    const number = Number(match[2]);
    options.push({ number, label: match[3]! });
    if (match[1] === SELECTED_OPTION_CURSOR) selectedNumber = number;
  }
  if (options.length === 0) return undefined;
  return { options, selectedNumber, firstLineIndex: firstOptionRowIndex };
}

function readQuestionAbove(lines: readonly string[], optionsFirstIndex: number): { question: string; firstLineIndex: number } {
  const lastIndex = lastNonBlankIndexBefore(lines, optionsFirstIndex);
  if (lastIndex < 0) return { question: '', firstLineIndex: optionsFirstIndex };
  let firstIndex = lastIndex;
  while (
    firstIndex - 1 >= 0 &&
    !isBlank(lines[firstIndex - 1]!) &&
    !QUOTED_LINE_PATTERN.test(lines[firstIndex - 1]!)
  ) {
    firstIndex -= 1;
  }
  const question = lines
    .slice(firstIndex, lastIndex + 1)
    .map((line) => line.trim())
    .join(' ');
  return { question, firstLineIndex: firstIndex };
}

function quotedRunsAbove(lines: readonly string[], questionFirstIndex: number): string[] {
  const runs: string[][] = [];
  let current: string[] | null = null;
  for (let index = questionFirstIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (BOX_SEPARATOR_PATTERN.test(line)) break;
    const quoted = QUOTED_LINE_PATTERN.exec(line);
    if (quoted !== null) {
      if (current === null) {
        current = [];
        runs.push(current);
      }
      current.unshift(quoted[1]!.trimEnd());
      continue;
    }
    current = null;
  }
  return runs.reverse().map((run) => run.join('\n'));
}

const BOX_TIP_PATTERN = /^\s*Tip:/u;
const CLAUDE_PERMISSION_HINTS = [CLAUDE_PERMISSION_PROMPT_HINT, CLAUDE_PERMISSION_PROMPT_HINT_OFF_FIRST_ROW] as const;

function boxBodyAbove(lines: readonly string[], questionFirstIndex: number): string | undefined {
  let separatorIndex = -1;
  for (let index = questionFirstIndex - 1; index >= 0; index -= 1) {
    if (BOX_SEPARATOR_PATTERN.test(lines[index]!)) {
      separatorIndex = index;
      break;
    }
  }
  if (separatorIndex < 0) return undefined;
  const body = lines
    .slice(separatorIndex + 1, questionFirstIndex)
    .filter((line) => !isBlank(line) && !BOX_TIP_PATTERN.test(line))
    .slice(1)
    .map((line) => line.trim());
  return body.length === 0 ? undefined : body.join('\n');
}

function detectClaudeInteractivePrompt(lines: readonly string[]): DetectedInteractivePrompt | undefined {
  const styledLines = styledLinesFromAnsi(lines.join('\n'));
  const hint = claudeFrameHasInteractiveMenuHint(styledLines)
    ? CLAUDE_INTERACTIVE_MENU_HINT
    : CLAUDE_PERMISSION_HINTS.find((candidate) => lastLineIndexMatching(lines, candidate) >= 0);
  if (hint === undefined) return undefined;
  const kind =
    hint === CLAUDE_INTERACTIVE_MENU_HINT ? INTERACTIVE_PROMPT_KINDS.QUESTION : INTERACTIVE_PROMPT_KINDS.PERMISSION;
  const hintIndex = lastLineIndexMatching(lines, hint);
  const optionBlock = readOptionBlockAbove(lines, hintIndex);
  if (optionBlock === undefined) return undefined;
  const { question, firstLineIndex } = readQuestionAbove(lines, optionBlock.firstLineIndex);
  const [quotedCommand, ...warnings] = quotedRunsAbove(lines, firstLineIndex);
  const command = quotedCommand ?? boxBodyAbove(lines, firstLineIndex);
  return {
    harness: HARNESS_NAMES.CLAUDE,
    kind,
    question,
    ...(command === undefined ? {} : { command }),
    warnings,
    options: optionBlock.options,
    selectedNumber: optionBlock.selectedNumber,
    hint,
  };
}

export function detectCodexInteractivePrompt(_lines: readonly string[]): DetectedInteractivePrompt | undefined {
  return undefined;
}

export function detectInteractivePrompt(screenText: string): DetectedInteractivePrompt | undefined {
  const lines = screenText.split('\n');
  return detectClaudeInteractivePrompt(lines) ?? detectCodexInteractivePrompt(lines);
}

export function selectedOptionOf(prompt: DetectedInteractivePrompt): InteractivePromptOption | undefined {
  return prompt.options.find((option) => option.number === prompt.selectedNumber);
}

export function offersOptionNumber(prompt: DetectedInteractivePrompt, number: number): boolean {
  return prompt.options.some((option) => option.number === number);
}
