import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-command.service.ts";

export interface DependencyHydrationPlan {
  readonly projectDir: string;
  readonly paths: readonly string[];
}

// Every manifest/lockfile whose content pins what a copied dependency
// directory (node_modules, .venv, target, …) should actually contain, across
// every supported ecosystem. Read from a project root to compute that
// project's CURRENT declared-dependency fingerprint, independent of which
// paths a given hydration call happens to be carrying.
const FINGERPRINT_MANIFESTS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "Package.swift",
  "Package.resolved",
  "pubspec.yaml",
  "pubspec.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "Podfile",
  "Podfile.lock",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  "pom.xml",
];

// Recorded inside each hydrated path itself (e.g.
// `node_modules/.throne-hydration-fingerprint.json`) so the marker travels
// with the directory when it is later reflink-cloned again as someone else's
// source, and so it never needs a project-root file that could confuse an
// ambient-dirt/untracked-content comparison elsewhere in the campaign
// tooling.
const HYDRATION_MARKER_FILENAME = ".throne-hydration-fingerprint.json";
const HYDRATION_PROVENANCE_FILENAME = ".throne-hydration-provenance.json";

/**
 * Fingerprint a project's CURRENT declared-dependency state: a hash over
 * every present manifest/lockfile's content. Two projects (or the same
 * project at two points in time) with an identical fingerprint declare the
 * same dependencies; a differing fingerprint means whatever was installed
 * against one manifest state is not proven to match the other. Returns
 * `undefined` when no recognized manifest is present at all (nothing to
 * fingerprint, so nothing to compare against).
 */
export async function manifestFingerprint(
  projectDir: string,
): Promise<string | undefined> {
  const parts: string[] = [];
  for (const filename of FINGERPRINT_MANIFESTS) {
    try {
      const content = await readFile(path.join(projectDir, filename));
      parts.push(
        `${filename}:${createHash("sha256").update(content).digest("hex")}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (parts.length === 0) return undefined;
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

export interface HydrationMarker {
  readonly fingerprint: string;
}

interface HydrationProvenance {
  readonly paths: readonly string[];
}

function parseHydrationProvenance(
  content: string,
  source: string,
): HydrationProvenance {
  const parsed: unknown = JSON.parse(content);
  const paths =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).paths
      : undefined;
  if (
    Array.isArray(paths) &&
    paths.every((entry): entry is string => typeof entry === "string")
  ) {
    return { paths };
  }
  throw new Error(`invalid dependency hydration provenance: ${source}`);
}

async function hydrationProvenancePaths(projectDir: string): Promise<{
  readonly legacy: string;
  readonly metadata: string;
}> {
  const gitDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    projectDir,
  );
  return {
    legacy: path.join(projectDir, HYDRATION_PROVENANCE_FILENAME),
    metadata: path.join(gitDir, HYDRATION_PROVENANCE_FILENAME),
  };
}

async function readProvenanceFile(
  source: string,
): Promise<HydrationProvenance | undefined> {
  try {
    return parseHydrationProvenance(await readFile(source, "utf8"), source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeLegacyProvenance(legacy: string): Promise<void> {
  await rm(legacy, { force: true });
}

export async function readHydrationProvenance(
  projectDir: string,
): Promise<HydrationProvenance | undefined> {
  const { legacy, metadata } = await hydrationProvenancePaths(projectDir);
  const [metadataProvenance, legacyProvenance] = await Promise.all([
    readProvenanceFile(metadata),
    readProvenanceFile(legacy),
  ]);
  if (legacyProvenance === undefined) return metadataProvenance;

  const paths = [
    ...new Set([
      ...(metadataProvenance?.paths ?? []),
      ...legacyProvenance.paths,
    ]),
  ].sort();
  await writeFile(metadata, `${JSON.stringify({ paths }, null, 2)}\n`);
  await removeLegacyProvenance(legacy);
  return { paths };
}

async function writeHydrationProvenancePaths(
  projectDir: string,
  paths: readonly string[],
): Promise<void> {
  const { legacy, metadata } = await hydrationProvenancePaths(projectDir);
  await writeFile(metadata, `${JSON.stringify({ paths }, null, 2)}\n`);
  await removeLegacyProvenance(legacy);
}

export async function writeHydrationProvenance(
  projectDir: string,
  hydratedPath: string,
): Promise<void> {
  const provenance = await readHydrationProvenance(projectDir);
  const paths = [
    ...new Set([...(provenance?.paths ?? []), hydratedPath]),
  ].sort();
  await writeHydrationProvenancePaths(projectDir, paths);
}

export async function readHydrationMarker(
  hydratedPath: string,
): Promise<HydrationMarker | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        path.join(hydratedPath, HYDRATION_MARKER_FILENAME),
        "utf8",
      ),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).fingerprint === "string"
    ) {
      return {
        fingerprint: (parsed as Record<string, unknown>).fingerprint as string,
      };
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeHydrationMarker(
  hydratedPath: string,
  fingerprint: string,
): Promise<void> {
  await writeFile(
    path.join(hydratedPath, HYDRATION_MARKER_FILENAME),
    `${JSON.stringify({ fingerprint }, null, 2)}\n`,
  );
}
