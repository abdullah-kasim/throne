import {
  OPENCODE_BOX_BOTTOM,
  OPENCODE_HEADER,
  OPENCODE_STATUS_LINE,
} from './opencode-screens.ts';

export const MESSAGE_ACTION_TITLE = 'Message Actions';
export const MESSAGE_ACTION_OPTIONS = [
  'Revert undo messages and file changes',
  'Copy message text to clipboard',
  'Fork create a new session',
] as const;

export const MESSAGE_ACTION_FRAME_WIDTH = 57;

/**
 * A message-action dialog panel line: the dialog backdrop occupies the full
 * width; content sits at a 6-column indent inside it. The captured live dialog
 * renders its title, Search filter, and option rows on this panel over the
 * dimmed session and composer beneath it.
 */
function messageActionLine(content: string): string {
  return `      ${content}`;
}

export function messageActionTitleLine(): string {
  const padding = MESSAGE_ACTION_FRAME_WIDTH - MESSAGE_ACTION_TITLE.length - 'esc'.length;
  return messageActionLine(
    `${MESSAGE_ACTION_TITLE}${' '.repeat(Math.max(0, padding))}esc`,
  );
}

export function messageActionOptionLines(
  options: readonly string[] = MESSAGE_ACTION_OPTIONS,
  selectedIndex = 0,
): string[] {
  return options.map((option, index) =>
    messageActionLine(`${index === selectedIndex ? '>' : ' '} ${option}`),
  );
}

/**
 * A message-action modal frame: a session transcript with a prior user message,
 * the dialog panel over it, and the dimmed composer box beneath (the composer
 * remains visible through the translucent backdrop, exactly as captured).
 */
export function openCodeMessageActionModalScreen(
  transcript: readonly string[],
  options: {
    options?: readonly string[];
    selectedIndex?: number;
    status?: boolean;
  } = {},
): string {
  return [
    ...transcript.map((line) => `     ${line}`),
    '',
    OPENCODE_HEADER,
    '',
    messageActionTitleLine(),
    '',
    messageActionLine('Search'),
    '',
    ...messageActionOptionLines(options.options, options.selectedIndex),
    '',
    '',
    '  ┃',
    '  ┃',
    '  ┃',
    '  ┃  Buildauto · DeepSeek V4 Flash (New) OpenCode Go· high',
    '  ┃',
    OPENCODE_BOX_BOTTOM,
    ...(options.status === false ? [] : [OPENCODE_STATUS_LINE]),
    '',
  ].join('\n');
}
