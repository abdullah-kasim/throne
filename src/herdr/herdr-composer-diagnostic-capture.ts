import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";

/**
 * Where the last-observed screen behind a "composer could not be
 * identified" timeout is persisted. Deliberately under the throne's own
 * durable data home (not a temp dir that gets swept) so a capture survives
 * long enough for someone to actually go look at it — see
 * `captureComposerTimeoutDiagnostic`'s own comment for why this exists.
 */
export const COMPOSER_DIAGNOSTIC_DIR = path.join(
  RUNTIME_DATA_HOME,
  "diagnostics",
  "composer-timeout",
);

function diagnosticFileName(recipientName: string, atMs: number): string {
  const safeRecipientName = recipientName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeTimestamp = new Date(atMs).toISOString().replace(/[:.]/g, "-");
  return `${safeTimestamp}-${safeRecipientName}.ansi`;
}

/**
 * Hard ceiling on the whole capture attempt. Proven necessary, not
 * theoretical: `mkdir(..., { recursive: true })` against an unwritable
 * path (e.g. under `/proc`) was observed to hang indefinitely on this box
 * rather than reject — no error, no timeout, just a promise that never
 * settles. A bare try/catch around the write is worthless against that; only
 * a race against a timer keeps the "never blocks delivery" promise real.
 */
const CAPTURE_TIMEOUT_MS = 2_000;

async function writeCapture(
  diagnosticDir: string,
  recipientName: string,
  visibleAnsi: string,
  now: () => number,
): Promise<string> {
  await mkdir(diagnosticDir, { recursive: true });
  const filePath = path.join(
    diagnosticDir,
    diagnosticFileName(recipientName, now()),
  );
  await writeFile(filePath, visibleAnsi, "utf8");
  return filePath;
}

/**
 * Forensic capture for the one failure class that kept defeating direct
 * reproduction (campaign cmz, 2026-08-14): `waitForRecognizedComposer`
 * repeatedly found the composer `unavailable` until its deadline, but every
 * reconstructed live shape (fresh spawn, welcome screen, mid-tool busy,
 * post-turn idle, a real long-scrolled pane) parsed correctly, so the
 * defect could not be diagnosed after the fact from a live pane that had
 * long since moved on. Persisting the LAST screen this court actually saw,
 * right before giving up on it, turns the next occurrence into real
 * evidence instead of another guessing exercise.
 *
 * Best-effort and silent on failure BY DESIGN: a diagnostic write must never
 * turn a legitimate not-sent report into something worse, must never block
 * or slow delivery, and must never itself become a new source of alarms (a
 * full disk or a permissions problem here is not the caller's emergency).
 * Races the write against `CAPTURE_TIMEOUT_MS` for exactly that reason — see
 * its comment.
 */
export async function captureComposerTimeoutDiagnostic(
  recipientName: string,
  visibleAnsi: string,
  now: () => number = Date.now,
  diagnosticDir: string = COMPOSER_DIAGNOSTIC_DIR,
): Promise<string | undefined> {
  try {
    return await Promise.race([
      writeCapture(diagnosticDir, recipientName, visibleAnsi, now),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), CAPTURE_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch {
    return undefined;
  }
}

/**
 * Builds `waitForRecognizedComposer`'s own final-timeout message, capturing
 * the last-observed screen (if any, via the optional injected dep) along
 * the way. Pulled out of that function itself purely to keep
 * herdr-screen.service.ts under the 500-line hand-authored file limit —
 * this has no reason to change independently of that one call site.
 */
export async function composerUnavailableTimeoutMessage(
  recipientName: string,
  lastVisibleAnsi: string | undefined,
  capture?: (recipientName: string, visibleAnsi: string) => Promise<string | undefined>,
): Promise<string> {
  const diagnosticPath =
    lastVisibleAnsi === undefined
      ? undefined
      : await capture?.(recipientName, lastVisibleAnsi).catch(() => undefined);
  return (
    "active bottom composer could not be identified before the " +
    "composer deadline; nothing was written" +
    (diagnosticPath === undefined
      ? ""
      : ` (last observed screen captured: ${diagnosticPath})`)
  );
}
