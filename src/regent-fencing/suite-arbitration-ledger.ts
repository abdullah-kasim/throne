import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * On-disk suite-arbitration ledger contract: append-only JSON Lines
 * recording every full-suite hold/release event, durable independent of any
 * particular Regent process's liveness.
 */
export interface SuiteArbitrationHoldLine {
  readonly type: "hold";
  readonly campaign: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface SuiteArbitrationReleaseLine {
  readonly type: "release";
  readonly campaign: string;
  readonly recordedAt: string;
}

export interface HeldCampaign {
  readonly campaign: string;
  readonly reason: string;
  readonly recordedAt: string;
}

export type SuiteArbitrationStateResult =
  | { readonly state: "ok"; readonly heldCampaigns: HeldCampaign[] }
  | { readonly state: "unknown"; readonly reason: string };

async function appendArbitrationLine(
  ledgerPath: string,
  line: SuiteArbitrationHoldLine | SuiteArbitrationReleaseLine,
): Promise<void> {
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(line)}\n`, "utf8");
}

/** Records that `campaign` now holds full-suite access. Called by Regent
 *  whenever it sequences a campaign into a full-suite run. */
export async function recordSuiteHold(
  ledgerPath: string,
  entry: { campaign: string; reason: string; recordedAt: string },
): Promise<void> {
  await appendArbitrationLine(ledgerPath, { type: "hold", ...entry });
}

/** Records that `campaign` has released full-suite access. Called by Regent
 *  once a held campaign's full-suite run finishes. A release with no prior
 *  matching hold is still recorded -- the fold below treats it as a no-op,
 *  never producing a negative hold. */
export async function recordSuiteRelease(
  ledgerPath: string,
  entry: { campaign: string; recordedAt: string },
): Promise<void> {
  await appendArbitrationLine(ledgerPath, { type: "release", ...entry });
}

function isHoldLine(value: unknown): value is SuiteArbitrationHoldLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "hold" &&
    typeof record.campaign === "string" &&
    record.campaign !== "" &&
    typeof record.reason === "string" &&
    record.reason !== "" &&
    typeof record.recordedAt === "string" &&
    record.recordedAt !== ""
  );
}

function isReleaseLine(value: unknown): value is SuiteArbitrationReleaseLine {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "release" &&
    typeof record.campaign === "string" &&
    record.campaign !== "" &&
    typeof record.recordedAt === "string" &&
    record.recordedAt !== ""
  );
}

/**
 * Folds the append-only hold/release ledger into the currently-held
 * campaigns: each hold sets the campaign held, each release (matching or
 * not) clears it, processed in append order. A missing ledger file reads as
 * `ok` with zero held campaigns -- nobody has ever held the suite yet. Any
 * unparseable or invalid line makes the whole read `unknown`.
 */
export async function readSuiteArbitrationState(
  ledgerPath: string,
): Promise<SuiteArbitrationStateResult> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { state: "ok", heldCampaigns: [] };
    }
    return {
      state: "unknown",
      reason: `suite-arbitration ledger "${ledgerPath}" is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const held = new Map<string, HeldCampaign>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return {
        state: "unknown",
        reason: `suite-arbitration ledger "${ledgerPath}" has an unparseable line: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (isHoldLine(parsed)) {
      held.set(parsed.campaign, {
        campaign: parsed.campaign,
        reason: parsed.reason,
        recordedAt: parsed.recordedAt,
      });
    } else if (isReleaseLine(parsed)) {
      held.delete(parsed.campaign);
    } else {
      return {
        state: "unknown",
        reason: `suite-arbitration ledger "${ledgerPath}" has a line matching neither the hold nor release contract`,
      };
    }
  }
  return { state: "ok", heldCampaigns: [...held.values()] };
}
