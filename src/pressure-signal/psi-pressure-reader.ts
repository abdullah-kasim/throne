import { readFileSync } from 'node:fs';

/**
 * A single PSI `some` reading carrying both the fast (`avg10`) and slow
 * (`avg60`) windows, or `unknown` if either could not be produced.
 */
export type PsiReading =
  | { readonly state: 'ok'; readonly avg10: number; readonly avg60: number }
  | { readonly state: 'unknown'; readonly avg10: null; readonly avg60: null };

const SOME_LINE_PATTERN =
  /^some\s.*\bavg10=([0-9]+(?:\.[0-9]+)?)\b.*\bavg60=([0-9]+(?:\.[0-9]+)?)\b/m;

export const UNKNOWN_PSI_READING: PsiReading = { state: 'unknown', avg10: null, avg60: null };

/**
 * Reads one `/proc/pressure/*` file and extracts its `some` line's `avg10`
 * and `avg60` figures. Never throws: a missing file, unreadable file, or
 * content missing EITHER field resolves to `unknown` rather than a default
 * value — a reading with only one window is not a partial success.
 */
export function readPsiPressure(pressurePath: string): PsiReading {
  let content: string;
  try {
    content = readFileSync(pressurePath, 'utf8');
  } catch {
    return UNKNOWN_PSI_READING;
  }

  const match = SOME_LINE_PATTERN.exec(content);
  if (!match) return UNKNOWN_PSI_READING;

  const avg10 = Number(match[1]);
  const avg60 = Number(match[2]);
  if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) return UNKNOWN_PSI_READING;

  return { state: 'ok', avg10, avg60 };
}
