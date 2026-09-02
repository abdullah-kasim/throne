import { readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dist` is published as a symlink to a uniquely-named `dist.build.<ts>-<pid>`
 * generation directory, swapped atomically by `scripts/build-and-publish-dist.mjs`
 * on every successful build. The generation *name* is a stable identity for
 * "which build populated dist" -- comparing it needs no content hashing, and
 * it can never observe a torn/mid-swap tree because the swap itself is a
 * single symlink rename.
 */
const GENERATION_SEGMENT_PATTERN = /dist\.build\.\d+-\d+/;

export interface DistGenerationDependencies {
  readonly readlink: (distLinkPath: string) => string;
}

export const REAL_DIST_GENERATION_DEPS: DistGenerationDependencies = {
  readlink: (distLinkPath) => readlinkSync(distLinkPath),
};

/** Reads which generation the `dist` symlink currently resolves to, on disk, right now. */
export function readCurrentDistGeneration(
  distLinkPath: string,
  dependencies: DistGenerationDependencies = REAL_DIST_GENERATION_DEPS,
): string | undefined {
  try {
    return path.basename(dependencies.readlink(distLinkPath));
  } catch {
    return undefined;
  }
}

/**
 * The identity of the generation THIS running module's own code was loaded
 * from, derived from its own `import.meta.url` rather than any external
 * signal. Node's ESM loader realpath's the module it loads, so a module
 * invoked through the atomic-publish `dist` symlink resolves through to its
 * real `dist.build.<gen>/...` path here -- this is what the process actually
 * executed, not merely what `dist` pointed to at some possibly-different
 * moment. Returns `undefined` outside a published generation tree (e.g. a
 * `ts-node`/test run), which callers treat as "no evidence" rather than a stale
 * verdict -- see the both-classes note in `service-generation-marker.ts`.
 */
export function resolveRepoRootAndGenerationFromModuleUrl(
  moduleUrl: string,
): { readonly repoRoot: string; readonly generation: string } | undefined {
  const modulePath = fileURLToPath(moduleUrl);
  const match = GENERATION_SEGMENT_PATTERN.exec(modulePath);
  if (!match) return undefined;
  const generationDirPath = modulePath.slice(0, match.index + match[0].length);
  return { repoRoot: path.dirname(generationDirPath), generation: path.basename(generationDirPath) };
}
