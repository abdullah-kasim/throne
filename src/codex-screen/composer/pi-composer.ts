import { plainText, type StyledCharacter } from "./ansi.ts";
import { normalizeRenderedPayload } from "./rendered-text.ts";
import type { ActiveComposerSnapshot } from "./composer.types.ts";

const PI_EDITOR_BORDER_PATTERN = /^─{8,}(?: .+ ─)?$/u;

function isPiEditorBorder(line: StyledCharacter[]): boolean {
  return PI_EDITOR_BORDER_PATTERN.test(plainText(line).trim());
}

export function readPiComposer(lines: StyledCharacter[][]): ActiveComposerSnapshot {
  const bottomBorder = lines.findLastIndex(isPiEditorBorder);
  if (bottomBorder === -1) return { state: "unavailable" };
  const topBorder = lines.slice(0, bottomBorder).findLastIndex(isPiEditorBorder);
  if (topBorder === -1) return { state: "unavailable" };
  const text = normalizeRenderedPayload(
    lines
      .slice(topBorder + 1, bottomBorder)
      .map((line) => plainText(line).trim())
      .filter((line) => line.length > 0)
      .join(" "),
  );
  return text.length === 0 ? { state: "empty", text: "" } : { state: "draft", text };
}
