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

const FULL_LINE_PATTERN =
  /^full\s.*\bavg10=([0-9]+(?:\.[0-9]+)?)\b.*\bavg60=([0-9]+(?:\.[0-9]+)?)\b/m;

const UNKNOWN: PsiReading = { state: 'unknown', avg10: null, avg60: null };

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
    return UNKNOWN;
  }

  const match = SOME_LINE_PATTERN.exec(content);
  if (!match) return UNKNOWN;

  const avg10 = Number(match[1]);
  const avg60 = Number(match[2]);
  if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) return UNKNOWN;

  return { state: 'ok', avg10, avg60 };
}

/**
 * The same reading taken from the `full` line — the share of time EVERY
 * non-idle task was stalled, rather than `some`'s "at least one was".
 *
 * WHY THIS EXISTS, measured 2026-08-27 on the live box:
 *
 *   /proc/pressure/io   some avg10=93.49 avg60=95.70
 *                       full avg10=27.10 avg60=49.43
 *
 * IO `some` sits in the nineties on any box doing concurrent work — one task
 * waiting on a disk read is the normal state of a multitasking system, so it
 * carries almost no capacity information. Folding it into the merged pressure
 * figure would have pinned that figure above every threshold permanently and
 * stopped the throne spawning anything ever again. `full` is the signal that
 * actually means "this box cannot make progress".
 *
 * Not used for cpu, where `full` is structurally always 0.00 (the kernel does
 * not report all-tasks-stalled for cpu), nor for memory, whose `some` is
 * already meaningful and low.
 */
export function readPsiFullPressure(pressurePath: string): PsiReading {
  let content: string;
  try {
    content = readFileSync(pressurePath, 'utf8');
  } catch {
    return UNKNOWN;
  }

  const match = FULL_LINE_PATTERN.exec(content);
  if (!match) return UNKNOWN;

  const avg10 = Number(match[1]);
  const avg60 = Number(match[2]);
  if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) return UNKNOWN;

  return { state: 'ok', avg10, avg60 };
}
