export function normalizeRenderedPayload(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function renderedContinuationSeparator(previousText: string): string {
  const trimmedPreviousText = previousText.trimEnd();
  const previousCharacter = trimmedPreviousText.slice(-1);
  const previousToken = trimmedPreviousText.match(/\S+$/u)?.[0] ?? "";
  const hyphenContinuesToken =
    previousCharacter === "-" && previousToken !== "-";
  return previousCharacter === "/" ||
    previousCharacter === "\\" ||
    hyphenContinuesToken
    ? ""
    : " ";
}

export function normalizeRenderedLineSequence(
  lines: readonly string[],
): string {
  const rendered = lines.reduce(
    (combined, line, index) =>
      index === 0
        ? line
        : combined + renderedContinuationSeparator(combined) + line,
    "",
  );
  return normalizeRenderedPayload(rendered);
}
