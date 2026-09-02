import {
  HARNESS_NAMES,
  runtimeHarness,
  type Harness,
  type RuntimeHarness,
} from "../../harness-routing/harness.ts";
import {
  firstNonWhitespaceIndex,
  plainText,
  type StyledCharacter,
} from "./ansi.ts";
import {
  normalizeRenderedLineSequence,
  normalizeRenderedPayload,
  renderedContinuationSeparator,
} from "./rendered-text.ts";

export interface PromptMarker {
  lineIndex: number;
  characterIndex: number;
  bold: boolean;
}

export interface PromptRegion {
  active: boolean;
  text: string;
}

const COMPOSER_MARKERS: Readonly<Record<RuntimeHarness, string>> = {
  [HARNESS_NAMES.CLAUDE]: "❯",
  [HARNESS_NAMES.CODEX]: "›",
  // The opencode TUI draws its composer as a box whose left edge is this heavy
  // vertical bar on every composer line, captured from live opencode panes
  // (the composer input itself carries no ❯/› glyph).
  [HARNESS_NAMES.OPENCODE]: "┃",
  // omp draws its composer as a rounded box whose bottom edge IS the input
  // line (`╰─ <draft text> ─╯`), with the model/status breadcrumb drawn into
  // the box's TOP edge instead of a separate footer row — confirmed against
  // a live omp pane (slice 05 recon, tmux capture of a real `bin/ompy`
  // launch). The marker is this bottom-left corner glyph; see
  // `isOmpComposerBottomEdge` for how a real composer edge is told apart
  // from an unrelated decorative box (e.g. the welcome screen's boxes, which
  // also close with a `╰` corner).
  [HARNESS_NAMES.OMP]: "╰",
};

const BORDER_CHARACTER_PATTERN = /^[\s─━╌╍┄┅┈┉╴╶╸╺│┃┆┇┊┋╎╏┌┐└┘├┤┬┴┼╭╮╰╯]+$/u;

const CODEX_PLAN_HINT = "Create a plan? shift + tab use Plan mode esc dismiss";

const CLAUDE_INTERACTIVE_MENU_HINT =
  "Enter to select · ↑/↓ to navigate · Esc to cancel";

/**
 * Claude renders its own interactive numbered-choice prompts (e.g. a
 * gate/permission menu) with this exact hint line beneath the option list.
 * It is chrome Claude draws itself, never composer input — its presence
 * anywhere in the frame means the ❯-marked region the composer marker
 * matched is the menu's own selected-option text, not a resident
 * human/agent draft sitting in the real composer.
 */
export function claudeFrameHasInteractiveMenuHint(
  lines: StyledCharacter[][],
): boolean {
  return lines.some(
    (line) =>
      normalizeRenderedPayload(plainText(line)) ===
      CLAUDE_INTERACTIVE_MENU_HINT,
  );
}

const CODEX_PLAN_HINT_RUNS = [
  { dim: false, text: "Createaplan?" },
  { dim: true, text: "shift+tab" },
  { dim: false, text: "usePlanmode" },
  { dim: true, text: "esc" },
  { dim: false, text: "dismiss" },
] as const;

export function isOpenCodeMessageActionsModal(
  lines: StyledCharacter[][],
): boolean {
  return lines.some((line) =>
    /^Message Actions.*esc$/u.test(normalizeRenderedPayload(plainText(line))),
  );
}

export function promptMarkerCandidates(
  lines: StyledCharacter[][],
  harness: Harness,
): PromptMarker[] {
  const marker = COMPOSER_MARKERS[runtimeHarness(harness)];
  const isOmp = runtimeHarness(harness) === HARNESS_NAMES.OMP;
  const candidates: PromptMarker[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const characterIndex = firstNonWhitespaceIndex(line);
    if (
      characterIndex === undefined ||
      line[characterIndex]!.value !== marker
    ) {
      continue;
    }
    if (isOmp && !isOmpComposerBottomEdge(line)) {
      continue;
    }
    candidates.push({
      lineIndex,
      characterIndex,
      bold: line[characterIndex]!.bold,
    });
  }
  return candidates;
}

export function activePromptMarker(
  candidates: PromptMarker[],
  harness: Harness,
  lines: StyledCharacter[][],
): PromptMarker | undefined {
  if (harness === HARNESS_NAMES.OPENCODE) {
    return openCodeActivePromptMarker(candidates, lines);
  }
  if (harness === HARNESS_NAMES.CODEX) {
    return candidates.findLast(({ bold }) => bold) ?? candidates.at(-1);
  }
  return candidates.at(-1);
}

function isComposerBoundary(line: StyledCharacter[]): boolean {
  const visible = line.filter(({ value }) => !/\s/u.test(value));
  if (visible.length === 0) {
    return false;
  }
  const text = plainText(line).trim();
  if (BORDER_CHARACTER_PATTERN.test(text)) {
    return true;
  }
  if (visible.every(({ dim }) => dim)) {
    return true;
  }
  const dimVisible = visible.filter(({ dim }) => dim);
  return (
    dimVisible.length === 1 &&
    dimVisible[0]!.value === "·" &&
    visible.some(({ dim }) => !dim)
  );
}

function isCodexPlanHintBoundary(line: StyledCharacter[]): boolean {
  if (normalizeRenderedPayload(plainText(line)) !== CODEX_PLAN_HINT) {
    return false;
  }
  const runs: Array<{ dim: boolean; text: string }> = [];
  for (const character of line) {
    if (/\s/u.test(character.value)) {
      continue;
    }
    const current = runs.at(-1);
    if (current?.dim === character.dim) {
      current.text += character.value;
    } else {
      runs.push({ dim: character.dim, text: character.value });
    }
  }
  return (
    runs.length === CODEX_PLAN_HINT_RUNS.length &&
    runs.every(
      (run, index) =>
        run.dim === CODEX_PLAN_HINT_RUNS[index]!.dim &&
        run.text === CODEX_PLAN_HINT_RUNS[index]!.text,
    )
  );
}

function isCodexQueueSubmitHintBoundary(
  lines: StyledCharacter[][],
  lineIndex: number,
): boolean {
  const currentAndNextLine = lines
    .slice(lineIndex, lineIndex + 2)
    .map(plainText);
  return /^tab to queue message(?:\s|$)/iu.test(
    normalizeRenderedLineSequence(currentAndNextLine),
  );
}

const CODEX_TURN_PARAGRAPH_SPACING = 2;

/**
 * Codex separates one completed transcript turn from whatever follows it —
 * another turn, or the composer chrome — by exactly two blank rows on both
 * sides (captured above every turn in both the stuck canary and the working
 * fixture alike). The live composer's own gap to the status footer
 * (`<model> <effort> · <cwd>`) is shorter: exactly one blank row, because the
 * footer is part of the composer's own chrome, not a separate turn. So a
 * bold `›` block bracketed by the full two-row turn spacing on BOTH sides —
 * above it and again below, before the footer — is Codex's recap of an
 * already-processed turn sitting where the (currently collapsed, invisible)
 * live composer would otherwise be, never the composer itself. A block
 * lacking known spacing above it (the top of the captured frame) is left
 * alone: there is no evidence it is a bracketed turn rather than genuinely
 * live content.
 */
function isCodexMarkerDetachedFromComposerFooter(
  reachedFooterBoundary: boolean,
  blankLinesAboveMarker: number,
  blankLinesBeforeFooterBoundary: number,
): boolean {
  return (
    reachedFooterBoundary &&
    blankLinesBeforeFooterBoundary >= CODEX_TURN_PARAGRAPH_SPACING &&
    blankLinesAboveMarker >= CODEX_TURN_PARAGRAPH_SPACING
  );
}

function countBlankLinesAbove(
  lines: StyledCharacter[][],
  lineIndex: number,
): number {
  let count = 0;
  let index = lineIndex - 1;
  while (index >= 0 && firstNonWhitespaceIndex(lines[index]!) === undefined) {
    count += 1;
    index -= 1;
  }
  return count;
}

export function readPromptRegion(
  lines: StyledCharacter[][],
  marker: PromptMarker,
  harness: Harness,
): PromptRegion {
  if (harness === HARNESS_NAMES.OPENCODE) {
    return readOpenCodePromptRegion(lines, marker);
  }
  if (harness === HARNESS_NAMES.OMP) {
    return readOmpPromptRegion(lines, marker);
  }
  const content: StyledCharacter[] = [
    ...lines[marker.lineIndex]!.slice(marker.characterIndex + 1),
  ];
  const continuationColumn = marker.characterIndex + 2;
  let active = true;
  let blankLinesBeforeFooterBoundary = 0;
  let reachedFooterBoundary = false;
  for (
    let lineIndex = marker.lineIndex + 1;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    const line = lines[lineIndex]!;
    const firstContent = firstNonWhitespaceIndex(line);
    if (firstContent === undefined) {
      blankLinesBeforeFooterBoundary += 1;
      continue;
    }
    if (isComposerBoundary(line)) {
      reachedFooterBoundary = true;
      break;
    }
    if (
      harness === HARNESS_NAMES.CODEX &&
      (isCodexPlanHintBoundary(line) ||
        isCodexQueueSubmitHintBoundary(lines, lineIndex))
    ) {
      break;
    }
    if (firstContent < continuationColumn) {
      active = false;
      break;
    }
    blankLinesBeforeFooterBoundary = 0;
    const continuationSeparator =
      renderedContinuationSeparator(plainText(content)) === ""
        ? []
        : [{ value: " ", bold: false, dim: false, muted: false }];
    content.push(...continuationSeparator, ...line.slice(continuationColumn));
  }
  const hasRealText = content.some(
    ({ value, dim }) => !dim && !/\s/u.test(value),
  );
  const detachedFromComposerFooter =
    harness === HARNESS_NAMES.CODEX &&
    isCodexMarkerDetachedFromComposerFooter(
      reachedFooterBoundary,
      countBlankLinesAbove(lines, marker.lineIndex),
      blankLinesBeforeFooterBoundary,
    );
  const realText =
    hasRealText && !detachedFromComposerFooter
      ? content.map(({ value }) => value).join("")
      : "";
  return { active, text: normalizeRenderedPayload(realText) };
}

/**
 * The opencode composer rule, decided once: the live composer is the
 * bottom-most `┃` content box closed by its `╹▀▀▀…` bottom edge. The opencode
 * TUI draws that box border down every prior box in the transcript scrollback
 * at one column, so marker selection must pick the bottom-most edge-closed box
 * — never the first marker — and the region reader must read only that box.
 * Active-marker selection, region reading, and the frame verdict all derive
 * from this one rule through the helpers below.
 */
function isOpenCodeBoxBottomEdge(line: StyledCharacter[]): boolean {
  return /^╹▀+/u.test(plainText(line).trim());
}

function isOpenCodeBoxLine(
  lines: StyledCharacter[][],
  lineIndex: number,
  markerColumn: number,
): boolean {
  const line = lines[lineIndex]!;
  const firstContent = firstNonWhitespaceIndex(line);
  return firstContent === markerColumn && line[firstContent]!.value === "┃";
}

function isOpenCodeBoxClosedByEdge(
  lines: StyledCharacter[][],
  marker: PromptMarker,
): boolean {
  for (
    let lineIndex = marker.lineIndex + 1;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    if (isOpenCodeBoxLine(lines, lineIndex, marker.characterIndex)) {
      continue;
    }
    return isOpenCodeBoxBottomEdge(lines[lineIndex]!);
  }
  return false;
}

function openCodeBoxTopMarker(
  lines: StyledCharacter[][],
  marker: PromptMarker,
): PromptMarker {
  let lineIndex = marker.lineIndex;
  while (
    lineIndex > 0 &&
    isOpenCodeBoxLine(lines, lineIndex - 1, marker.characterIndex)
  ) {
    lineIndex -= 1;
  }
  return {
    lineIndex,
    characterIndex: marker.characterIndex,
    bold: marker.bold,
  };
}

function openCodeActivePromptMarker(
  candidates: PromptMarker[],
  lines: StyledCharacter[][],
): PromptMarker | undefined {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const boxTop = openCodeBoxTopMarker(lines, candidates[index]!);
    if (isOpenCodeBoxClosedByEdge(lines, boxTop)) {
      return boxTop;
    }
  }
  const last = candidates.at(-1);
  return last === undefined ? undefined : openCodeBoxTopMarker(lines, last);
}

/**
 * The opencode TUI draws its composer as a box: every box line carries the
 * `┃` marker at the box column, and the box is closed at the bottom by a
 * `╹▀▀▀…` edge line. Selection is the bottom-most edge-closed box, so the
 * reader walks exactly that box from its top and stops at the edge. The box's
 * bottom-most content-bearing line is the model status row, which the reader
 * recognizes by shape and never treats as input; the input is every other
 * content-bearing box line, joined across wraps with the shared rendered-wrap
 * normalization. A leading braille spinner character on an input line is the
 * composer's cursor chrome (captured on every non-empty composer), never part
 * of the payload. An absent box edge with content means an interactive dialog
 * covers the composer; an absent edge without input means the frame is
 * incomplete.
 */
function readOpenCodePromptRegion(
  lines: StyledCharacter[][],
  marker: PromptMarker,
): PromptRegion {
  const markerColumn = marker.characterIndex;
  const contentLines: StyledCharacter[][] = [];
  const contentStartColumns: number[] = [];
  for (
    let lineIndex = marker.lineIndex;
    lineIndex < lines.length;
    lineIndex += 1
  ) {
    if (!isOpenCodeBoxLine(lines, lineIndex, markerColumn)) {
      break;
    }
    const line = lines[lineIndex]!;
    const contentStart = line.findIndex(
      ({ value }, index) => index > markerColumn && !/\s/u.test(value),
    );
    const contentEnd = line.findLastIndex(
      ({ value }, index) => index > markerColumn && !/\s/u.test(value),
    );
    if (contentStart === -1 || contentEnd === -1) {
      continue;
    }
    const lineContent = line.slice(contentStart, contentEnd + 1);
    if (isOpenCodePlaceholderChrome(lineContent)) {
      continue;
    }
    contentStartColumns.push(contentStart);
    contentLines.push(lineContent);
  }
  const content: StyledCharacter[] = [];
  const inputLines = contentLines.slice(
    0,
    openCodeModelStatusStart(contentLines, contentStartColumns, markerColumn),
  );
  for (const [index, lineContent] of inputLines.entries()) {
    if (index > 0) {
      const continuationSeparator =
        renderedContinuationSeparator(plainText(content)) === ""
          ? []
          : [{ value: " ", bold: false, dim: false, muted: false }];
      content.push(...continuationSeparator);
    }
    const spinnerStripped = lineContent.filter(
      (character, characterIndex) =>
        characterIndex > 0 || !isOpenCodeSpinner(character),
    );
    content.push(...spinnerStripped);
  }
  const text = normalizeRenderedPayload(
    content.map(({ value }) => value).join(""),
  );
  return { active: true, text };
}

function isOpenCodeSpinner(character: StyledCharacter): boolean {
  const codePoint = character.value.codePointAt(0)!;
  return codePoint >= 0x2800 && codePoint <= 0x28ff;
}

function isOpenCodePlaceholderChrome(line: StyledCharacter[]): boolean {
  const visible = line.filter(
    (character) =>
      !/\s/u.test(character.value) && !isOpenCodeSpinner(character),
  );
  return visible.length > 0 && visible.every(({ muted }) => muted);
}

// Right-aligned model-status path fragments begin well past the composer input
// column (captured at column 114 in wide panes); left-aligned input starts
// within a few columns of the marker.
const OPENCODE_MODEL_PATH_COLUMN_OFFSET = 12;

/**
 * The model-status display occupies the bottom of the composer box. Its last
 * content line is the model row (recognized by leading shape); when the cwd
 * path is longer than the box width, the wrapped path fragments render as
 * right-aligned content on the lines directly above it. Live input is always
 * left-aligned (starts within a few columns of the marker), so a content line
 * whose text begins well past the input column is a wrapped path fragment, not
 * input. This returns the index of the first model-status content line.
 */
function openCodeModelStatusStart(
  contentLines: StyledCharacter[][],
  contentStartColumns: number[],
  markerColumn: number,
): number {
  const lastIndex = contentLines.length - 1;
  if (lastIndex < 0 || !isOpenCodeModelLine(contentLines[lastIndex]!)) {
    return contentLines.length;
  }
  let start = lastIndex;
  while (
    start > 0 &&
    contentStartColumns[start - 1]! >
      markerColumn + OPENCODE_MODEL_PATH_COLUMN_OFFSET
  ) {
    start -= 1;
  }
  return start;
}

/**
 * The composer footer row: the mode and model status rendered inside the box
 * directly above the bottom edge in every captured frame — `Build · <model>
 * OpenCode Go · max` with a `Buildauto` mode variant, a ` · <effort>` suffix,
 * and a ` <cwd>:<branch>` path suffix (live frames render the row as
 * `Build auto · <model> OpenCode Go <cwd>:<branch>`). The box shows it whether
 * or not input exists, so the region reader must recognize it by its leading
 * shape, never treat it as input.
 */
function isOpenCodeModelLine(lineContent: StyledCharacter[]): boolean {
  const text = plainText(lineContent);
  return /^Build(?:\s*auto)?\s*·/u.test(text) && /OpenCode Go/u.test(text);
}

export function openCodeFrameHasBoxBottom(lines: StyledCharacter[][]): boolean {
  return lines.some(isOpenCodeBoxBottomEdge);
}

/**
 * omp's composer box closes on a `╰─ <text> ─╯` row — one corner, exactly
 * ONE dash, then a space, then the draft (or padding when empty). Every
 * other box omp draws (the welcome screen's tip/model panels, the queued
 * suggestion list) closes with a `╰` corner run into two-or-more contiguous
 * dashes (`╰──…`) and never a lone dash followed by a space, so this shape
 * is what tells a real composer edge apart from decorative chrome.
 */
function isOmpComposerBottomEdge(line: StyledCharacter[]): boolean {
  return /^╰─ /u.test(plainText(line));
}

/**
 * A wrapped composer draft continues the box on the lines directly above
 * the bottom edge, each opening with `│` and two spaces before the content
 * — the same content column (3) as the bottom edge's `╰─ ` opens with, so
 * both shapes read through the shared column offset below.
 */
function isOmpComposerContinuationLine(line: StyledCharacter[]): boolean {
  return /^│ {2}/u.test(plainText(line));
}

const OMP_BOX_CONTENT_COLUMN = 3;

/**
 * Both the bottom edge and any continuation line above it fill out to the
 * box's fixed right edge with trailing spaces/dashes closed by `╯`/`│`; that
 * trailing run is chrome, never part of the draft, and is stripped here
 * before the lines are stitched back together.
 */
function stripOmpBoxTrailingBorder(text: string): string {
  return text.replace(/[\s─]*[╮╯│]\s*$/u, "");
}

/**
 * omp's status/model breadcrumb (`Opus 5 · high > throne > …`) is drawn
 * into the box's TOP edge rather than a separate footer row (unlike
 * Codex/Claude/opencode), so the reader never needs to recognize and skip a
 * footer line the way those harnesses do — walking upward from the bottom
 * edge while lines keep matching the continuation shape already stops
 * exactly at the top edge, which fails that shape and is excluded.
 */
function readOmpPromptRegion(
  lines: StyledCharacter[][],
  marker: PromptMarker,
): PromptRegion {
  let topLineIndex = marker.lineIndex;
  while (
    topLineIndex > 0 &&
    isOmpComposerContinuationLine(lines[topLineIndex - 1]!)
  ) {
    topLineIndex -= 1;
  }
  const boxLines: string[] = [];
  for (
    let lineIndex = topLineIndex;
    lineIndex <= marker.lineIndex;
    lineIndex += 1
  ) {
    const raw = plainText(lines[lineIndex]!).slice(OMP_BOX_CONTENT_COLUMN);
    boxLines.push(stripOmpBoxTrailingBorder(raw));
  }
  const text = normalizeRenderedLineSequence(boxLines);
  return { active: true, text };
}
