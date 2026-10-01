export const TYPED_PROMPT = 'typed';
export const RELAYED_PROMPT = 'relayed';
export const TASK_NOTIFICATION_PROMPT = 'task-notification';
export const OTHER_PROMPT = 'other';

export const PROMPT_KINDS = [
  TYPED_PROMPT,
  RELAYED_PROMPT,
  TASK_NOTIFICATION_PROMPT,
  OTHER_PROMPT,
] as const;

export type PromptKind = (typeof PROMPT_KINDS)[number];

const PASTED_CONTENT_TAG = /<\/?pasted_content\b[^>]*>/g;
const DELIVERED_MESSAGE_NUMBER_AT_THE_END = /\[message \d+\]\s*$/;
const TASK_NOTIFICATION_OPENING = /^\s*<task-notification>/;
const HARNESS_WRAPPER_OPENING = /^\s*<[a-z][\w-]*>/;

function withPastedContentUnwrapped(prompt: string): string {
  return prompt.replace(PASTED_CONTENT_TAG, '');
}

function isDeliveredAgentMessage(text: string): boolean {
  return DELIVERED_MESSAGE_NUMBER_AT_THE_END.test(text);
}

export function promptKindOf(prompt: string): PromptKind {
  const unwrapped = withPastedContentUnwrapped(prompt);
  if (TASK_NOTIFICATION_OPENING.test(unwrapped)) return TASK_NOTIFICATION_PROMPT;
  if (isDeliveredAgentMessage(unwrapped)) return RELAYED_PROMPT;
  if (HARNESS_WRAPPER_OPENING.test(unwrapped)) return OTHER_PROMPT;
  return TYPED_PROMPT;
}
