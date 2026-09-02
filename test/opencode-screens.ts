/**
 * Capture-derived opencode pane rendering vocabulary shared by parser and
 * submit-engine tests. The fixtures reproduce the layout a live opencode pane
 * emits: every composer-box line carries the `┃` marker at column 2, the box
 * closes with a `╹▀▀▀…` edge, a `Build · …` model row sits inside the box
 * directly above that edge, and a status row follows below it. A non-empty
 * input renders a braille spinner before the first line. None of the captured
 * opencode chrome uses SGR bold or dim, so verdicts turn on layout, not
 * styling.
 */
export const RESET = '\u001b[0m';
export const MARKER_BLUE = '\u001b[38;2;92;156;245m';
export const BOX_BACKGROUND = '\u001b[48;2;30;30;30m';
export const OPENCODE_MARKER = '┃';
export const OPENCODE_SPINNER = '⠏';
export const OPENCODE_MODEL_LINE =
  '  ┃  Build · DeepSeek V4 Flash (New) OpenCode Go · max';
export const OPENCODE_MODEL_LINE_PATH =
  '  ┃  Build auto · DeepSeek V4 Flash (New) OpenCode Go  /var/home/theuser/repos/throne:main';
export const OPENCODE_MODEL_LINE_EFFORT =
  '  ┃  Buildauto  ·DeepSeek V4 Flash (New) OpenCode Go· high';
export const OPENCODE_BOX_BOTTOM = `  ╹${'▀'.repeat(55)}`;
export const OPENCODE_STATUS_LINE =
  '   ⬝⬝⬝  esc interrupt 33.0K (43%) · $0.30 ctrl+p commands';
export const OPENCODE_HEADER = '     ▣  Build · DeepSeek V4 Flash (New)';
export const OPENCODE_LANDING_PLACEHOLDER =
  'Ask anything... "Fix a TODO in the codebase"';
export const OPENCODE_LANDING_PLACEHOLDER_GREY = '\u001b[38;2;128;128;128m';
export const OPENCODE_LANDING_MODEL_LINE =
  '  ┃  Build · DeepSeek V4 Flash (New) OpenCode Go · high';
export const OPENCODE_LANDING_MODEL_LINE_BUILDAUTO =
  '  ┃  Buildauto · DeepSeek V4 Flash (New) OpenCode Go · high';
export const OPENCODE_LANDING_TIP =
  '● Tip Use {env:VAR_NAME} for environment variables in config';

/** One composer-box line: two spaces, the marker, two spaces, content. */
export function openCodeComposerLine(content: string): string {
  return `  ${RESET}${MARKER_BLUE}${OPENCODE_MARKER}${RESET}${BOX_BACKGROUND}  ${content}${RESET}`;
}

/**
 * Render a payload the way a live pane shows it: the first box line carries
 * the spinner chrome, wrapped continuations sit at the deeper indent.
 */
export function openCodeComposerLines(
  payload: string,
  width = 57,
): string[] {
  const chunks = wrapOpenCodePayload(payload, width);
  return chunks.map((chunk, index) =>
    index === 0
      ? openCodeComposerLine(`${OPENCODE_SPINNER} ${chunk}`)
      : openCodeComposerLine(`  ${chunk}`),
  );
}

export function wrapOpenCodePayload(
  payload: string,
  width: number,
): string[] {
  const chunks: string[] = [];
  for (const segment of payload.split('\n')) {
    let remaining = segment;
    while (remaining.length > width) {
      let cut = remaining.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    chunks.push(remaining);
  }
  return chunks;
}

/** A full opencode frame: transcript, header, composer box, edge, status. */
export function openCodeScreen(
  transcript: readonly string[],
  composerLines: readonly string[],
  options: {
    modelLine?: string | false;
    bottom?: boolean;
    status?: boolean;
  } = {},
): string {
  const modelLine =
    options.modelLine === false
      ? []
      : [options.modelLine ?? OPENCODE_MODEL_LINE];
  return [
    ...transcript.map((line) => `     ${line}`),
    '',
    OPENCODE_HEADER,
    '',
    ...composerLines,
    ...modelLine,
    ...(options.bottom === false ? [] : [OPENCODE_BOX_BOTTOM]),
    ...(options.status === false ? [] : [OPENCODE_STATUS_LINE]),
    '',
  ].join('\n');
}

/**
 * A permission dialog over the composer: box lines with content and no model
 * row, edge, or status row beneath them — the captured dialog frame's shape.
 */
export function openCodeModalScreen(
  modalLines: readonly string[],
): string {
  return [
    OPENCODE_HEADER,
    '',
    ...modalLines.map((line) => openCodeComposerLine(line)),
    '',
    '',
  ].join('\n');
}

export function openCodeLandingScreen(options: {
  modelLine?: string;
  tip?: boolean;
} = {}): string {
  const modelLine = options.modelLine ?? OPENCODE_LANDING_MODEL_LINE;
  const tipLines = options.tip === true ? ['', OPENCODE_LANDING_TIP] : [];
  return [
    openCodeComposerLine(''),
    openCodeComposerLine(
      `${OPENCODE_LANDING_PLACEHOLDER_GREY}${OPENCODE_LANDING_PLACEHOLDER}`,
    ),
    openCodeComposerLine(''),
    modelLine,
    OPENCODE_BOX_BOTTOM,
    ...tipLines,
    '',
  ].join('\n');
}
