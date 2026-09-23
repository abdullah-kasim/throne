import { IdentityLineReadStatus, readAgentRole, type IdentityLineRead } from '../agentdata/identity-data.service.ts';
import { resolveCurrentAgentName } from '../herdr/herdr-session.service.ts';
import { pressPaneKey } from '../herdr/herdr-client.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import { readVisibleText, resolveAgent } from '../herdr/herdr-runtime.service.ts';
import { isQueueFilerRoleName } from '../shared-policy/objective-contract.ts';
import { canonicalRegentAuthority } from '../shared-policy/regent-authority.ts';
import { submitToAgentViaQueue } from '../throne-work/enqueue-heartbeat-message.ts';
import { submitPageToRegent } from '../blocked-paging/blocked-agent-paging.hosted-worker.ts';
import { buildMcqTakeOverPagingMessage } from '../blocked-paging/blocked-agent-paging-message.ts';
import {
  detectInteractivePrompt,
  offersOptionNumber,
  type DetectedInteractivePrompt,
} from './detect-interactive-prompt.ts';
import { MCQ_USAGE, parseMcqArguments, type McqArguments } from './mcq-arguments.ts';
import { appendMcqAnswerLedgerEntry, MCQ_OUTCOMES, type McqAnswerLedgerEntry } from './mcq-answer-ledger.ts';

export const McqExitCode = {
  Done: 0,
  Usage: 2,
  CallerRefused: 3,
  NoSuchPrompt: 4,
  TakeOver: 5,
} as const;

export const MCQ_KEYS = {
  UP: 'up',
  DOWN: 'down',
  ENTER: 'enter',
  ESCAPE: 'esc',
} as const;
type McqKey = (typeof MCQ_KEYS)[keyof typeof MCQ_KEYS] | `${number}`;

export const MCQ_REPAINT_POLL_MS = 250;
export const MCQ_REPAINT_TIMEOUT_MS = 2_000;

export interface McqDependencies {
  readonly currentAgentName: () => Promise<string>;
  readonly readRole: (name: string) => Promise<IdentityLineRead>;
  readonly resolveAgent: (name: string) => Promise<HerdrAgent>;
  readonly readPaneText: (paneId: string) => Promise<string>;
  readonly pressKey: (paneId: string, key: McqKey) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  readonly pageRegent: (message: string, pageKey: string) => Promise<void>;
  readonly appendLedger: (entry: McqAnswerLedgerEntry) => Promise<void>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const REAL_MCQ_DEPENDENCIES: McqDependencies = {
  currentAgentName: resolveCurrentAgentName,
  readRole: (name) => readAgentRole(name),
  resolveAgent: (name) => resolveAgent(name),
  readPaneText: readVisibleText,
  pressKey: (paneId, key) => pressPaneKey(paneId, key),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  pageRegent: (message, pageKey) =>
    submitPageToRegent(message, pageKey, { resolveAgent, submitToAgent: submitToAgentViaQueue }),
  appendLedger: (entry) => appendMcqAnswerLedgerEntry(entry),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

async function refusalForCaller(callerName: string, deps: McqDependencies): Promise<string | undefined> {
  if (canonicalRegentAuthority(callerName) !== undefined) return undefined;
  const role = await deps.readRole(callerName);
  if (role.status === IdentityLineReadStatus.Found && isQueueFilerRoleName(role.value)) return undefined;
  return (
    `mcq: only the Regent or a Stager may answer another agent's prompt; "${callerName}" is ` +
    `${role.status === IdentityLineReadStatus.Found ? `a ${role.value}` : 'not identifiable'}. ` +
    'Tell your supervisor what the prompt says instead.'
  );
}

function samePrompt(first: DetectedInteractivePrompt, second: DetectedInteractivePrompt): boolean {
  return (
    first.question === second.question &&
    first.command === second.command &&
    first.options.length === second.options.length &&
    first.options.every((option, index) => option.label === second.options[index]!.label)
  );
}

function renderPrompt(prompt: DetectedInteractivePrompt): string {
  const rows = prompt.options
    .map((option) => `  ${option.number === prompt.selectedNumber ? '❯' : ' '} ${option.number}. ${option.label}`)
    .join('\n');
  return [
    `${prompt.harness} ${prompt.kind} prompt: ${prompt.question}`,
    ...(prompt.command === undefined ? [] : [`command:\n${prompt.command}`]),
    ...prompt.warnings.map((warning) => `warning: ${warning}`),
    rows,
  ].join('\n');
}

function rowIndexOf(prompt: DetectedInteractivePrompt, optionNumber: number | null): number {
  return prompt.options.findIndex((option) => option.number === optionNumber);
}

function rowLabel(prompt: DetectedInteractivePrompt, rowIndex: number): string {
  const option = prompt.options[rowIndex];
  return option === undefined ? 'no row' : `row ${option.number} (${option.label})`;
}

interface PaneFrame {
  readonly text: string;
  readonly prompt: DetectedInteractivePrompt | undefined;
}

async function readFrame(paneId: string, deps: McqDependencies): Promise<PaneFrame> {
  const text = await deps.readPaneText(paneId);
  return { text, prompt: detectInteractivePrompt(text) };
}

async function pressAndWaitForRepaint(
  paneId: string,
  key: McqKey,
  before: PaneFrame,
  deps: McqDependencies,
): Promise<PaneFrame> {
  await deps.pressKey(paneId, key);
  const deadline = deps.now() + MCQ_REPAINT_TIMEOUT_MS;
  let frame = before;
  while (deps.now() < deadline) {
    await deps.sleep(MCQ_REPAINT_POLL_MS);
    frame = await readFrame(paneId, deps);
    if (frame.text !== before.text) return frame;
  }
  return frame;
}

function originalPromptIsGone(original: DetectedInteractivePrompt, frame: PaneFrame): boolean {
  return frame.prompt === undefined || !samePrompt(original, frame.prompt);
}

type KeyPressOutcome =
  | { readonly kind: 'cleared' }
  | { readonly kind: 'cursor-at'; readonly rowIndex: number; readonly frame: PaneFrame }
  | { readonly kind: 'take-over'; readonly reason: string };

function describeCursorAfterPress(
  original: DetectedInteractivePrompt,
  key: McqKey,
  frame: PaneFrame,
): KeyPressOutcome {
  if (originalPromptIsGone(original, frame)) return { kind: 'cleared' };
  const rowIndex = rowIndexOf(frame.prompt!, frame.prompt!.selectedNumber);
  if (rowIndex < 0) {
    return { kind: 'take-over', reason: `after pressing ${key} the prompt is still visible but no row carries the cursor.` };
  }
  return { kind: 'cursor-at', rowIndex, frame };
}

async function pressEnterOnSelectedTarget(
  paneId: string,
  original: DetectedInteractivePrompt,
  frame: PaneFrame,
  deps: McqDependencies,
): Promise<KeyPressOutcome> {
  const after = await pressAndWaitForRepaint(paneId, MCQ_KEYS.ENTER, frame, deps);
  if (originalPromptIsGone(original, after)) return { kind: 'cleared' };
  return { kind: 'take-over', reason: 'after pressing Enter on the selected target row the prompt is still visible.' };
}

async function walkCursorWithArrows(
  paneId: string,
  original: DetectedInteractivePrompt,
  startFrame: PaneFrame,
  startRowIndex: number,
  targetRowIndex: number,
  deps: McqDependencies,
): Promise<KeyPressOutcome> {
  let frame = startFrame;
  let rowIndex = startRowIndex;
  const step = targetRowIndex > rowIndex ? 1 : -1;
  const key = step > 0 ? MCQ_KEYS.DOWN : MCQ_KEYS.UP;
  while (rowIndex !== targetRowIndex) {
    const expectedRowIndex = rowIndex + step;
    const after = await pressAndWaitForRepaint(paneId, key, frame, deps);
    const outcome = describeCursorAfterPress(original, key, after);
    if (outcome.kind === 'cleared') {
      return { kind: 'take-over', reason: `after pressing ${key} the prompt disappeared before the target row was selected.` };
    }
    if (outcome.kind === 'take-over') return outcome;
    if (outcome.rowIndex !== expectedRowIndex) {
      return {
        kind: 'take-over',
        reason:
          `after pressing ${key} expected the cursor on ${rowLabel(original, expectedRowIndex)}, ` +
          `observed ${rowLabel(original, outcome.rowIndex)}.`,
      };
    }
    rowIndex = outcome.rowIndex;
    frame = outcome.frame;
  }
  return pressEnterOnSelectedTarget(paneId, original, frame, deps);
}

async function answerPrompt(
  paneId: string,
  first: PaneFrame,
  optionNumber: number,
  deps: McqDependencies,
): Promise<KeyPressOutcome> {
  const original = first.prompt!;
  const startRowIndex = rowIndexOf(original, original.selectedNumber);
  const targetRowIndex = rowIndexOf(original, optionNumber);
  const digitKey = `${optionNumber}` as McqKey;
  const afterDigit = describeCursorAfterPress(original, digitKey, await pressAndWaitForRepaint(paneId, digitKey, first, deps));
  if (afterDigit.kind !== 'cursor-at') return afterDigit;
  if (afterDigit.rowIndex === targetRowIndex) {
    return pressEnterOnSelectedTarget(paneId, original, afterDigit.frame, deps);
  }
  if (afterDigit.rowIndex !== startRowIndex) {
    return {
      kind: 'take-over',
      reason:
        `after pressing ${digitKey} expected the cursor on ${rowLabel(original, targetRowIndex)} or still on ` +
        `${rowLabel(original, startRowIndex)}, observed ${rowLabel(original, afterDigit.rowIndex)}.`,
    };
  }
  return walkCursorWithArrows(paneId, original, afterDigit.frame, startRowIndex, targetRowIndex, deps);
}

async function dismissPrompt(paneId: string, first: PaneFrame, deps: McqDependencies): Promise<KeyPressOutcome> {
  const after = await pressAndWaitForRepaint(paneId, MCQ_KEYS.ESCAPE, first, deps);
  if (originalPromptIsGone(first.prompt!, after)) return { kind: 'cleared' };
  return { kind: 'take-over', reason: 'after pressing Escape the prompt is still visible.' };
}

function plannedKeys(prompt: DetectedInteractivePrompt, action: McqArguments['action']): string {
  if (action.kind === 'dismiss') return `would press: ${MCQ_KEYS.ESCAPE}, then verify the prompt is gone`;
  const startRowIndex = rowIndexOf(prompt, prompt.selectedNumber);
  const targetRowIndex = rowIndexOf(prompt, action.optionNumber);
  const distance = targetRowIndex - startRowIndex;
  const arrows =
    startRowIndex < 0
      ? 'no cursor is visible, so no arrow fallback is possible; a failed digit press pages the Regent'
      : distance === 0
        ? `${MCQ_KEYS.ENTER}`
        : `${distance > 0 ? MCQ_KEYS.DOWN : MCQ_KEYS.UP} x${Math.abs(distance)} (cursor checked after each), then ${MCQ_KEYS.ENTER}`;
  return `would press: ${action.optionNumber}, verify the cursor; fallback: ${arrows}`;
}

function ledgerEntry(
  parsed: McqArguments,
  caller: string,
  paneId: string,
  prompt: DetectedInteractivePrompt,
  outcome: McqAnswerLedgerEntry['outcome'],
  detail: string | undefined,
  deps: McqDependencies,
): McqAnswerLedgerEntry {
  const chosen =
    parsed.action.kind === 'dismiss'
      ? 'dismiss'
      : prompt.options.find((option) => option.number === (parsed.action as { optionNumber: number }).optionNumber)!;
  return {
    time: new Date(deps.now()).toISOString(),
    caller,
    agent: parsed.agentName,
    pane: paneId,
    kind: prompt.kind,
    question: prompt.question,
    ...(prompt.command === undefined ? {} : { command: prompt.command }),
    chosen,
    outcome,
    ...(detail === undefined ? {} : { detail }),
  };
}

async function pageRegentToTakeOver(
  parsed: McqArguments,
  caller: string,
  paneId: string,
  reason: string,
  deps: McqDependencies,
): Promise<void> {
  const message = buildMcqTakeOverPagingMessage({ agentName: parsed.agentName, paneId, caller, reason });
  await deps.pageRegent(message, `mcq-take-over:${parsed.agentName}:${deps.now()}`);
  deps.err(`mcq: ${reason} Pressed nothing further. Paged the Regent to take over: press the keys by hand.\n`);
}

export async function runMcq(args: readonly string[], deps: McqDependencies = REAL_MCQ_DEPENDENCIES): Promise<number> {
  let parsed: McqArguments;
  try {
    parsed = parseMcqArguments(args);
  } catch (error) {
    deps.err(`${error instanceof Error ? error.message : String(error)}\n${MCQ_USAGE}\n`);
    return McqExitCode.Usage;
  }
  let caller: string;
  try {
    caller = await deps.currentAgentName();
  } catch (error) {
    deps.err(`mcq: could not resolve the calling agent (${error instanceof Error ? error.message : String(error)}); only the Regent or a Stager may answer prompts.\n`);
    return McqExitCode.CallerRefused;
  }
  const refusal = await refusalForCaller(caller, deps);
  if (refusal !== undefined) {
    deps.err(`${refusal}\n`);
    return McqExitCode.CallerRefused;
  }
  const target = await deps.resolveAgent(parsed.agentName);
  const first = await readFrame(target.paneId, deps);
  if (first.prompt === undefined) {
    deps.err(`mcq: no interactive prompt is visible in ${parsed.agentName}'s pane ${target.paneId}; nothing pressed.\n`);
    return McqExitCode.NoSuchPrompt;
  }
  if (parsed.action.kind === 'answer' && !offersOptionNumber(first.prompt, parsed.action.optionNumber)) {
    deps.err(
      `mcq: option ${parsed.action.optionNumber} is not offered; the prompt offers ` +
        `${first.prompt.options.map((option) => `${option.number} (${option.label})`).join(', ')}. Nothing pressed.\n`,
    );
    return McqExitCode.NoSuchPrompt;
  }
  deps.out(`${renderPrompt(first.prompt)}\n`);
  if (parsed.dryRun) {
    deps.out(`${plannedKeys(first.prompt, parsed.action)}\n`);
    return McqExitCode.Done;
  }
  const outcome =
    parsed.action.kind === 'dismiss'
      ? await dismissPrompt(target.paneId, first, deps)
      : await answerPrompt(target.paneId, first, parsed.action.optionNumber, deps);
  if (outcome.kind === 'take-over') {
    await deps.appendLedger(ledgerEntry(parsed, caller, target.paneId, first.prompt, MCQ_OUTCOMES.TAKE_OVER, outcome.reason, deps));
    await pageRegentToTakeOver(parsed, caller, target.paneId, outcome.reason, deps);
    return McqExitCode.TakeOver;
  }
  const settled = parsed.action.kind === 'dismiss' ? MCQ_OUTCOMES.DISMISSED : MCQ_OUTCOMES.ANSWERED;
  await deps.appendLedger(ledgerEntry(parsed, caller, target.paneId, first.prompt, settled, undefined, deps));
  deps.out(
    parsed.action.kind === 'dismiss'
      ? `mcq: dismissed the prompt in ${parsed.agentName}'s pane ${target.paneId}.\n`
      : `mcq: answered ${parsed.action.optionNumber} in ${parsed.agentName}'s pane ${target.paneId}; the prompt is gone.\n`,
  );
  return McqExitCode.Done;
}
