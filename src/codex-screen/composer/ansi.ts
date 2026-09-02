export interface CharacterStyle {
  bold: boolean;
  dim: boolean;
  muted: boolean;
}

export interface StyledCharacter extends CharacterStyle {
  value: string;
}

const EXTENDED_COLOR_INTRODUCERS = new Set([38, 48, 58]);

const NEUTRAL_GREY_BRIGHTNESS_LIMIT = 200;

export function isNeutralGreyMuted(
  red: number,
  green: number,
  blue: number,
): boolean {
  return red === green && green === blue && red < NEUTRAL_GREY_BRIGHTNESS_LIMIT;
}

function indexedColorToRgb(
  index: number,
): { red: number; green: number; blue: number } | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    return undefined;
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return { red: level, green: level, blue: level };
  }
  if (index >= 16) {
    const value = index - 16;
    const red = Math.floor(value / 36);
    const green = Math.floor((value % 36) / 6);
    const blue = value % 6;
    const cubeLevel = (channel: number): number =>
      channel === 0 ? 0 : 55 + channel * 40;
    return {
      red: cubeLevel(red),
      green: cubeLevel(green),
      blue: cubeLevel(blue),
    };
  }
  const systemLevels = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [192, 192, 192],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ] as const;
  const system = systemLevels[index]!;
  return { red: system[0], green: system[1], blue: system[2] };
}

function mutedFromExtendedColor(
  colorSpace: number,
  parts: readonly string[],
  colorIndex: number,
): boolean {
  if (colorSpace === 2) {
    return isNeutralGreyMuted(
      Number.parseInt(parts[colorIndex] ?? "", 10),
      Number.parseInt(parts[colorIndex + 1] ?? "", 10),
      Number.parseInt(parts[colorIndex + 2] ?? "", 10),
    );
  }
  if (colorSpace === 5) {
    const rgb = indexedColorToRgb(Number.parseInt(parts[colorIndex] ?? "", 10));
    return rgb === undefined
      ? false
      : isNeutralGreyMuted(rgb.red, rgb.green, rgb.blue);
  }
  return false;
}

function applySgrCode(code: number, style: CharacterStyle): void {
  if (code === 0) {
    style.bold = false;
    style.dim = false;
    style.muted = false;
  } else if (code === 1) {
    style.bold = true;
  } else if (code === 2) {
    style.dim = true;
  } else if (code === 22) {
    style.bold = false;
    style.dim = false;
    style.muted = false;
  } else if (
    code === 39 ||
    (code >= 30 && code <= 37) ||
    (code >= 90 && code <= 97)
  ) {
    style.muted = false;
  }
}

function updateStyleFromSgr(parameters: string, style: CharacterStyle): void {
  const parts = parameters.length === 0 ? ["0"] : parameters.split(";");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const code = Number.parseInt(part.split(":")[0] ?? "", 10);
    if (!part.includes(":") && EXTENDED_COLOR_INTRODUCERS.has(code)) {
      const colorSpace = Number.parseInt(parts[index + 1] ?? "", 10);
      if (code === 38) {
        style.muted = mutedFromExtendedColor(colorSpace, parts, index + 2);
      }
      index += colorSpace === 5 ? 2 : colorSpace === 2 ? 4 : 0;
      continue;
    }
    applySgrCode(code, style);
  }
}

function controlSequenceEnd(text: string, start: number): number | undefined {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return undefined;
}

function operatingSystemCommandEnd(
  text: string,
  start: number,
): number | undefined {
  for (let index = start; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x07) {
      return index + 1;
    }
    if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") {
      return index + 2;
    }
  }
  return undefined;
}

export function styledLinesFromAnsi(text: string): StyledCharacter[][] {
  const lines: StyledCharacter[][] = [[]];
  const style: CharacterStyle = { bold: false, dim: false, muted: false };
  let index = 0;
  while (index < text.length) {
    const value = text[index]!;
    if (value === "\n") {
      lines.push([]);
      index += 1;
      continue;
    }
    if (value === "\r") {
      index += 1;
      continue;
    }
    if (value === "\u001b") {
      const kind = text[index + 1];
      if (kind === "[") {
        const end = controlSequenceEnd(text, index + 2);
        if (end === undefined) {
          break;
        }
        if (text[end] === "m") {
          updateStyleFromSgr(text.slice(index + 2, end), style);
        }
        index = end + 1;
        continue;
      }
      if (kind === "]") {
        index = operatingSystemCommandEnd(text, index + 2) ?? text.length;
        continue;
      }
      index += Math.min(2, text.length - index);
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (codePoint < 0x20 && character !== "\t") {
      continue;
    }
    lines.at(-1)!.push({ value: character, ...style });
  }
  return lines;
}

export function firstNonWhitespaceIndex(
  line: StyledCharacter[],
): number | undefined {
  const index = line.findIndex(({ value }) => !/\s/u.test(value));
  return index === -1 ? undefined : index;
}

export function plainText(line: StyledCharacter[]): string {
  return line.map(({ value }) => value).join("");
}
