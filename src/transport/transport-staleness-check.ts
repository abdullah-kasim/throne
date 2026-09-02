import path from "node:path";
import { readCurrentDistGeneration, resolveRepoRootAndGenerationFromModuleUrl } from "../status/dist-generation.ts";
import type { TransportResponseEnvelope } from "./transport-wire-contract.ts";

/**
 * Thrown when a REST response's `serverGeneration` differs from the CLI
 * process's own current dist generation -- distinguishable from
 * `TransportConnectionError` (the backend never answered) and from a
 * `TransportErrorEnvelope` of kind `"application"` (the backend answered but
 * the route itself failed). This means the backend answered successfully
 * from code that predates the caller's own rebuild.
 */
export class TransportStaleServerError extends Error {
  readonly serverGeneration: string;
  readonly currentGeneration: string;

  constructor(serverGeneration: string, currentGeneration: string) {
    super(
      `throne-backend is running a stale build (server generation ${serverGeneration}, ` +
        `current generation ${currentGeneration}) -- restart throne-backend to pick up the rebuilt dist`,
    );
    this.name = "TransportStaleServerError";
    this.serverGeneration = serverGeneration;
    this.currentGeneration = currentGeneration;
  }
}

export interface TransportStalenessDependencies {
  readonly readCurrentGeneration: () => string | undefined;
}

/**
 * Mirrors `DEFAULT_SERVICE_STALENESS_DEPENDENCIES.readCurrentGeneration` in
 * `src/status/service-staleness.ts`: same two reused readers, evaluated
 * against this module's own `import.meta.url` since it is this client
 * process's generation identity that matters here, not the status-reporting
 * command's.
 */
export const DEFAULT_TRANSPORT_STALENESS_DEPENDENCIES: TransportStalenessDependencies = {
  readCurrentGeneration: () => {
    const resolved = resolveRepoRootAndGenerationFromModuleUrl(import.meta.url);
    if (!resolved) return undefined; // not running from a published generation -- no basis to compare
    return readCurrentDistGeneration(path.join(resolved.repoRoot, "dist"));
  },
};

/**
 * Checks one transport response for generation staleness relative to the
 * calling CLI process's own current dist. Silent (returns `undefined`) when
 * either side's generation is unknown -- absence of evidence is never
 * treated as staleness, matching `readServiceGenerationStaleness`'s
 * false-positive guard. Does not mutate or reject the response; the caller
 * decides how to surface a detected staleness.
 */
export function checkTransportResponseStaleness(
  response: TransportResponseEnvelope,
  dependencies: TransportStalenessDependencies = DEFAULT_TRANSPORT_STALENESS_DEPENDENCIES,
): TransportStaleServerError | undefined {
  const currentGeneration = dependencies.readCurrentGeneration();
  if (currentGeneration === undefined) return undefined;
  if (response.serverGeneration === undefined) return undefined;
  if (response.serverGeneration === currentGeneration) return undefined;
  return new TransportStaleServerError(response.serverGeneration, currentGeneration);
}
