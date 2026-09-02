import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";
import { resolveRepoRootAndGenerationFromModuleUrl } from "./dist-generation.ts";

/**
 * Durable per-user home, independent of any single checkout or generation
 * directory, so the marker outlives the exact `dist.build.<gen>` tree its own
 * writer process ran from.
 */
export const SERVICE_GENERATION_MARKER_DIR = path.join(RUNTIME_DATA_HOME, "state", "service-generation");

export interface ServiceGenerationMarker {
  readonly generation: string;
  readonly startedAt: string;
  readonly pid: number;
}

export function serviceGenerationMarkerPath(
  unitName: string,
  markerDir: string = SERVICE_GENERATION_MARKER_DIR,
): string {
  return path.join(markerDir, `${unitName}.json`);
}

/**
 * Stamped once, at process startup, by each long-running service this
 * campaign tracks. Records which dist generation THIS process actually
 * resolved through its own ESM loader -- ground truth about what code is
 * running, not a guess from a timestamp or an externally-observed file. A
 * failure here (read-only home, missing dir) must never take down the service
 * it is only reporting on, so callers are expected to swallow the error.
 */
export function writeServiceGenerationMarker(
  unitName: string,
  moduleUrl: string,
  startedAt: string,
  pid: number,
  markerDir: string = SERVICE_GENERATION_MARKER_DIR,
): void {
  const resolved = resolveRepoRootAndGenerationFromModuleUrl(moduleUrl);
  if (!resolved) return; // not running from a published generation (e.g. dev/ts-node) -- nothing to stamp
  const marker: ServiceGenerationMarker = { generation: resolved.generation, startedAt, pid };
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(serviceGenerationMarkerPath(unitName, markerDir), `${JSON.stringify(marker)}\n`);
}

/**
 * `writeServiceGenerationMarker`, but a write fault can never propagate to
 * the caller. A long-running service's marker write happens both once at
 * startup and, for backfill/keep-current purposes, repeatedly for the life
 * of the process (see `runThroneWorkDispatchLoop`'s `onTick` hook and
 * `ServiceGenerationMarkerRefreshHostedWorker`) -- a recurring write gets far
 * more chances to throw than a one-off, so it must degrade to "this refresh
 * was skipped, try again next cycle" rather than take the service down.
 * Mirrors `recordDeliveryFailureNoticeSafely`'s catch-log-continue shape.
 *
 * Calling this repeatedly with the same `moduleUrl` is exactly how a marker
 * is kept current without ever changing the `generation` it reports: the
 * generation is a pure function of `moduleUrl`, which is fixed for the life
 * of a process, so a "refresh" is just this same write repeated -- it never
 * re-resolves to whatever happens to be newest on disk. Re-resolving on
 * refresh would make a stale process look current and defeat
 * `readServiceGenerationStaleness`'s detection outright.
 */
export function writeServiceGenerationMarkerSafely(
  unitName: string,
  moduleUrl: string,
  startedAt: string,
  pid: number,
  markerDir: string = SERVICE_GENERATION_MARKER_DIR,
): void {
  try {
    writeServiceGenerationMarker(unitName, moduleUrl, startedAt, pid, markerDir);
  } catch (error) {
    process.stderr.write(
      `service-generation-marker: write failed for ${unitName}, continuing: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

/** Reads back a previously stamped marker. Missing or corrupt is "no evidence", never an error. */
export function readServiceGenerationMarker(
  unitName: string,
  markerDir: string = SERVICE_GENERATION_MARKER_DIR,
): ServiceGenerationMarker | undefined {
  try {
    const raw = readFileSync(serviceGenerationMarkerPath(unitName, markerDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ServiceGenerationMarker>;
    if (
      typeof parsed.generation !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.pid !== "number"
    ) {
      return undefined;
    }
    return { generation: parsed.generation, startedAt: parsed.startedAt, pid: parsed.pid };
  } catch {
    return undefined;
  }
}
