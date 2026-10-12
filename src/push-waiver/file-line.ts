export interface FileLine {
  readonly path: string;
  readonly line: number;
}

const FILE_LINE_PATTERN = /^(?<path>[^\s:][^\s]*):(?<line>[1-9]\d*)$/;

export function parseFileLine(text: string): FileLine | undefined {
  const match = FILE_LINE_PATTERN.exec(text);
  if (match?.groups === undefined) {
    return undefined;
  }
  return { path: match.groups.path!, line: Number(match.groups.line) };
}

export function formatFileLine(location: FileLine): string {
  return `${location.path}:${location.line}`;
}
