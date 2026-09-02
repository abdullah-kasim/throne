/**
 * Capture-derived Claude pane rendering vocabulary shared by parser and
 * submit-engine tests. The fixtures reproduce the styling a live Claude pane
 * emits, byte for byte: the composer hint arrives SGR-dim, typed text and
 * queued entries arrive in truecolor, and the collapsed-paste placeholder
 * arrives unstyled. Verdicts turn on that styling, so the escape sequences are
 * the fixture — not decoration around it.
 */
export const RESET = '\u001b[0m';
export const DIM = '\u001b[2m';
export const WHITE = '\u001b[38;2;255;255;255m';
const MARKER_GREY = '\u001b[38;2;153;153;153m';
const QUEUED_MARKER_GREY = '\u001b[38;2;80;80;80m';
const QUEUED_BACKGROUND = '\u001b[48;2;55;55;55m';
const BORDER_GREY = '\u001b[38;2;136;136;136m';

/** Claude separates the composer from its status footer with this rule. */
const BORDER = `${RESET}${BORDER_GREY}${'─'.repeat(62)}${RESET}`;
const STATUS_FOOTER = `  ${RESET}${MARKER_GREY}Haiku 4.5 · effort:? · ~/.throne/worktrees/monorepo/shadow…${RESET}`;

export const DIM_HINT = `${RESET}${DIM}Press up to edit queued messages${RESET}`;
export const PASTE_PLACEHOLDER = `${RESET}[Pasted text #2 +19 lines]`;

/** The composer marker is followed by a non-breaking space, then content. */
export function claudeComposerLine(content: string): string {
  return `${RESET}${MARKER_GREY}❯ ${content}`;
}

/** Queued entries render as a 2-space-indented shaded box with white text. */
export function claudeQueuedEntry(text: string): string {
  return `  ${RESET}${QUEUED_MARKER_GREY}${QUEUED_BACKGROUND}❯ ${RESET}${WHITE}${QUEUED_BACKGROUND}${text}${RESET}${QUEUED_BACKGROUND}      ${RESET}`;
}

/**
 * Wrapped rows inside a queued box. They carry no `❯` of their own, so a pane
 * showing only these — what a body taller than the viewport leaves behind once
 * its marker row scrolls off — holds no parsable entry at all.
 */
export function claudeQueuedEntryContinuations(
  ...lines: readonly string[]
): string[] {
  return lines.map(
    (line) =>
      `  ${RESET}${QUEUED_BACKGROUND}  ${RESET}${WHITE}${QUEUED_BACKGROUND}${line}${RESET}`,
  );
}

/** A queued entry whose body continues over wrapped lines inside the box. */
export function claudeQueuedEntryLines(
  first: string,
  ...continuations: readonly string[]
): string[] {
  return [
    claudeQueuedEntry(first),
    ...claudeQueuedEntryContinuations(...continuations),
  ];
}

export function claudeScreen(...lines: readonly string[]): string {
  return [...lines, BORDER, STATUS_FOOTER].join('\n');
}
