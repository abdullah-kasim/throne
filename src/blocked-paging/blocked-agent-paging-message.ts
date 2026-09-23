import {
  SELECTED_OPTION_CURSOR,
  type DetectedInteractivePrompt,
} from '../pane-prompts/detect-interactive-prompt.ts';

export interface BlockedAgentPagingMessageParams {
  readonly agentName: string;
  readonly cwd?: string;
  readonly paneId: string;
  readonly title: string | null;
  readonly stateLabels: Readonly<Record<string, string>>;
  readonly prompt?: DetectedInteractivePrompt;
}

export const REGENT_PROMPT_SAFETY_SENTENCE = 'Regent: judge whether the command is safe before answering.';

export function mcqAnswerCommandLine(agentName: string, optionNumber: number | '<n>'): string {
  return `throne mcq --agent ${agentName} --answer ${optionNumber}`;
}

export function mcqDismissCommandLine(agentName: string): string {
  return `throne mcq --agent ${agentName} --dismiss`;
}

function renderOptions(prompt: DetectedInteractivePrompt): string {
  return prompt.options
    .map((option) =>
      `${option.number === prompt.selectedNumber ? SELECTED_OPTION_CURSOR : ' '} ${option.number}. ${option.label}`,
    )
    .join('\n');
}

function renderDetectedPrompt(agentName: string, prompt: DetectedInteractivePrompt): string {
  const selected =
    prompt.selectedNumber === null ? 'no option is selected' : `option ${prompt.selectedNumber} is selected`;
  return [
    `Prompt (${prompt.harness} ${prompt.kind}): ${prompt.question}`,
    ...(prompt.command === undefined ? [] : [`Command:\n${prompt.command}`]),
    ...prompt.warnings.map((warning) => `Warning: ${warning}`),
    `Options (${selected}):\n${renderOptions(prompt)}`,
    `Clear it with: ${mcqAnswerCommandLine(agentName, '<n>')}  or  ${mcqDismissCommandLine(agentName)}`,
    REGENT_PROMPT_SAFETY_SENTENCE,
  ].join('\n');
}

function renderContext(params: BlockedAgentPagingMessageParams): string {
  return [
    `pane: ${params.paneId}`,
    params.cwd ? `worktree: ${params.cwd}` : undefined,
    params.title ? `title: ${params.title}` : undefined,
    Object.keys(params.stateLabels).length > 0
      ? `state_labels: ${Object.entries(params.stateLabels)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('; ');
}

export function buildBlockedAgentPagingMessage(params: BlockedAgentPagingMessageParams): string {
  const context = renderContext(params);
  if (params.prompt === undefined) {
    return (
      `${params.agentName} is blocked and is not a supervising ` +
      `Alpha with a live child (${context}). It is stuck, not merely waiting on a ` +
      `child -- inspect it and answer for it directly.`
    );
  }
  return (
    `${params.agentName} is held up by an interactive prompt in its pane and is not a supervising ` +
    `Alpha with a live child (${context}).\n` +
    renderDetectedPrompt(params.agentName, params.prompt)
  );
}

export function buildMcqTakeOverPagingMessage(params: {
  readonly agentName: string;
  readonly paneId: string;
  readonly caller: string;
  readonly reason: string;
}): string {
  return (
    `${params.caller} ran throne mcq for ${params.agentName} (pane: ${params.paneId}) and stopped pressing keys: ` +
    `${params.reason} Regent, take over: press the keys by hand.`
  );
}
