import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  manifestFingerprint,
  readHydrationMarker,
  readHydrationProvenance,
  writeHydrationMarker,
  writeHydrationProvenance,
  type DependencyHydrationPlan,
} from "./dependency-hydration-fingerprint.ts";

export { type DependencyHydrationPlan } from "./dependency-hydration-fingerprint.ts";
import {
  installFallbackPath,
  isReflinkTrustworthy,
  resolveInstallFallbackPaths,
  type DependencyHydrationMode,
  type DependencyHydrationResult,
  type DependencyInstallPlatform,
  NpmInstallPlatform,
} from "./dependency-hydration-install.ts";

export {
  isReflinkTrustworthy,
  NpmInstallPlatform,
  type DependencyHydrationMode,
  type DependencyHydrationResult,
  type DependencyInstallPlatform,
} from "./dependency-hydration-install.ts";

export type DependencyEcosystem =
  | "npm"
  | "pnpm"
  | "yarn"
  | "python"
  | "rust"
  | "swift"
  | "dart"
  | "ruby"
  | "php"
  | "cocoapods"
  | "gradle"
  | "maven";

export interface HydrationConfig {
  readonly ecosystems?: readonly DependencyEcosystem[];
  readonly paths?: readonly string[];
  readonly legacyUnsafe?: boolean;
}

export interface DependencyCopyPlatform {
  copy(source: string, destination: string): Promise<void>;
}

const DEFAULT_PATHS: Readonly<Record<DependencyEcosystem, readonly string[]>> =
  {
    npm: ["node_modules"],
    pnpm: ["node_modules"],
    yarn: ["node_modules"],
    python: [".venv"],
    rust: ["target"],
    swift: [".build"],
    dart: [".dart_tool"],
    ruby: ["vendor/bundle"],
    php: ["vendor"],
    cocoapods: ["Pods"],
    gradle: [".gradle"],
    maven: ["target"],
  };

const ECOSYSTEM_MANIFESTS: Readonly<
  Record<DependencyEcosystem, readonly string[]>
> = {
  npm: ["package.json"],
  pnpm: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
  yarn: ["yarn.lock"],
  python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
  rust: ["Cargo.toml"],
  swift: ["Package.swift"],
  dart: ["pubspec.yaml"],
  ruby: ["Gemfile"],
  php: ["composer.json"],
  cocoapods: ["Podfile"],
  gradle: ["build.gradle", "build.gradle.kts"],
  maven: ["pom.xml"],
};

const OVERRIDE_FILE = "data/gittree.dependency-hydration.json";
const LEGACY_OVERRIDE_FILE = "data/gittree.reflink-dirs.json";
const REFUSED_SEGMENTS = new Set([
  ".git",
  ".env",
  ".ssh",
  ".aws",
  ".config",
  "runtime",
  "tmp",
  "cache",
]);
function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function configFromUnknown(value: unknown, source: string): HydrationConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const config = value as Record<string, unknown>;
  const ecosystems = config.ecosystems;
  const paths = config.paths;
  if (
    ecosystems !== undefined &&
    (!Array.isArray(ecosystems) ||
      !ecosystems.every(
        (entry) => typeof entry === "string" && entry in DEFAULT_PATHS,
      ))
  ) {
    throw new Error(
      `${source}: ecosystems must contain supported ecosystem names`,
    );
  }
  if (
    paths !== undefined &&
    (!Array.isArray(paths) ||
      !paths.every((entry) => typeof entry === "string"))
  ) {
    throw new Error(`${source}: paths must be an array of strings`);
  }
  return {
    ...(ecosystems === undefined
      ? {}
      : { ecosystems: ecosystems as DependencyEcosystem[] }),
    ...(paths === undefined ? {} : { paths: paths as string[] }),
  };
}

export async function readHydrationConfig(
  projectDir: string,
): Promise<HydrationConfig> {
  const source = path.join(projectDir, OVERRIDE_FILE);
  try {
    return configFromUnknown(
      JSON.parse(await readFile(source, "utf8")),
      source,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const legacySource = path.join(projectDir, LEGACY_OVERRIDE_FILE);
  try {
    const parsed: unknown = JSON.parse(await readFile(legacySource, "utf8"));
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        `${legacySource}: expected a JSON array of dir-name strings`,
      );
    }
    return { paths: parsed, legacyUnsafe: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function defaultHydrationPaths(
  ecosystems: readonly DependencyEcosystem[],
): readonly string[] {
  return unique(ecosystems.flatMap((ecosystem) => DEFAULT_PATHS[ecosystem]));
}

async function detectEcosystems(
  projectDir: string,
): Promise<readonly DependencyEcosystem[]> {
  const detected: DependencyEcosystem[] = [];
  for (const ecosystem of Object.keys(
    ECOSYSTEM_MANIFESTS,
  ) as DependencyEcosystem[]) {
    for (const manifest of ECOSYSTEM_MANIFESTS[ecosystem]) {
      try {
        await access(path.join(projectDir, manifest));
        detected.push(ecosystem);
        break;
      } catch {
        // An absent manifest does not declare this ecosystem.
      }
    }
  }
  return detected;
}

export function validateHydrationPath(relativePath: string): string {
  if (relativePath === "" || path.isAbsolute(relativePath))
    throw new Error(
      `dependency hydration path must be relative: ${relativePath}`,
    );
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`))
    throw new Error(
      `dependency hydration path escapes project: ${relativePath}`,
    );
  const segments = normalized.split(path.sep);
  if (
    segments.some(
      (segment) => REFUSED_SEGMENTS.has(segment) || segment.startsWith(".env"),
    )
  ) {
    throw new Error(
      `dependency hydration path is secret or runtime state: ${relativePath}`,
    );
  }
  return normalized;
}

export async function buildHydrationPlan(
  projectDir: string,
  config?: HydrationConfig,
): Promise<DependencyHydrationPlan> {
  const resolved = config ?? (await readHydrationConfig(projectDir));
  const ecosystems =
    resolved.ecosystems ??
    (resolved.paths === undefined ? await detectEcosystems(projectDir) : []);
  const validate = resolved.legacyUnsafe
    ? (entry: string) => {
        if (entry === "" || path.isAbsolute(entry)) {
          throw new Error(
            `dependency hydration path must be relative: ${entry}`,
          );
        }
        const normalized = path.normalize(entry);
        if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
          throw new Error(
            `dependency hydration path escapes project: ${entry}`,
          );
        }
        return normalized;
      }
    : validateHydrationPath;
  const paths = unique(
    (resolved.paths ?? defaultHydrationPaths(ecosystems)).map(validate),
  );
  for (const relativePath of paths) {
    let candidate = projectDir;
    for (const segment of relativePath.split(path.sep)) {
      candidate = path.join(candidate, segment);
      try {
        const entry = await lstat(candidate);
        if (entry.isSymbolicLink())
          throw new Error(
            `dependency hydration refuses symlink path: ${relativePath}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
  return { projectDir, paths };
}

export async function hydrateDependencies(
  sourceProjectDir: string,
  destinationProjectDir: string,
  config?: HydrationConfig,
  platform: DependencyCopyPlatform = new NodeCopyPlatform(),
  installer: DependencyInstallPlatform = new NpmInstallPlatform(),
): Promise<DependencyHydrationResult> {
  const plan = await buildHydrationPlan(sourceProjectDir, config);
  if (plan.paths.length === 0) {
    return { projectDir: destinationProjectDir, paths: [], mode: "skipped" };
  }

  // The divergence guard: a reflink clone is a SNAPSHOT of the source's
  // dependency directories taken right now. It is only safe to trust when
  // the source's own declared dependencies still match what the destination
  // was actually checked out at — otherwise the copy silently carries an
  // older (or newer) install than the tree it lands in, and every later
  // measurement against that tree is comparing broken-vs-broken instead of
  // a real baseline. Compare once per call (not per path): every hydrated
  // path shares the same source/destination pair.
  const sourceFingerprint = await manifestFingerprint(sourceProjectDir);
  const destinationFingerprint = await manifestFingerprint(
    destinationProjectDir,
  );
  const reflinkTrustworthy = isReflinkTrustworthy(
    sourceFingerprint,
    destinationFingerprint,
  );
  const hydrationPaths = reflinkTrustworthy
    ? plan.paths
    : await resolveInstallFallbackPaths(
        sourceProjectDir,
        destinationProjectDir,
        plan.paths,
        DEFAULT_PATHS.npm[0],
      );

  let mode: DependencyHydrationMode = "skipped";

  for (const relativePath of hydrationPaths) {
    if (reflinkTrustworthy) {
      const source = path.join(sourceProjectDir, relativePath);
      try {
        await access(source);
      } catch {
        continue;
      }

      // The source's own copy of this dependency directory can itself be
      // stale relative to the source's CURRENT manifests — most concretely
      // when a Shadow spawns from an Alpha whose own tree was hydrated
      // earlier and never reinstalled after gaining new dependencies. The
      // manifest-vs-manifest comparison above cannot see this (it only
      // knows manifest TEXT, not install state), so a marker left by an
      // earlier hydration of this exact directory is the only signal
      // available: if one exists and disagrees with the source's current
      // fingerprint, the source itself is unhydrated and must not be
      // propagated further.
      const sourceMarker = await readHydrationMarker(source);
      if (
        sourceMarker !== undefined &&
        sourceFingerprint !== undefined &&
        sourceMarker.fingerprint !== sourceFingerprint
      ) {
        throw new Error(
          `dependency hydration refuses a stale source: "${source}" was hydrated ` +
            "against an earlier dependency state than its own current manifests " +
            `declare. Hydrate "${sourceProjectDir}" itself (e.g. rerun its ` +
            "install command) before spawning a tree from it — otherwise the " +
            "staleness would inherit two levels deep.",
        );
      }

      const destination = path.join(destinationProjectDir, relativePath);
      try {
        await access(destination);
        continue;
      } catch {
        // The fresh worktree normally has no ignored destination yet.
      }
      await platform.copy(source, destination);
      if (destinationFingerprint !== undefined) {
        await writeHydrationMarker(destination, destinationFingerprint);
      }
      await writeHydrationProvenance(destinationProjectDir, relativePath);
      mode = "reflink";
      continue;
    }

    // Reachable only for the npm dependency path (any other ecosystem path
    // already threw above, before this loop started): no trustworthy
    // reflink source, so hydrate by really installing into the destination.
    const destination = path.join(destinationProjectDir, relativePath);
    try {
      await access(destination);
      continue;
    } catch {
      // The fresh worktree normally has no ignored destination yet.
    }
    await installFallbackPath(destinationProjectDir, relativePath, installer);
    await writeHydrationProvenance(destinationProjectDir, relativePath);
    mode = "install";
  }

  return { projectDir: destinationProjectDir, paths: hydrationPaths, mode };
}

export async function validateHydratedDependencies(
  projectDir: string,
  config?: HydrationConfig,
): Promise<void> {
  const plan = await buildHydrationPlan(projectDir, config);
  const currentFingerprint = await manifestFingerprint(projectDir);
  const provenance = await readHydrationProvenance(projectDir);
  const hydratedPaths = new Set(provenance?.paths);
  for (const relativePath of plan.paths) {
    const hydratedPath = path.join(projectDir, relativePath);
    try {
      await access(hydratedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!hydratedPaths.has(relativePath)) continue;
        throw new Error(
          `declared dependency path is missing: ${relativePath} (project: ${projectDir})`,
        );
      }
      throw error;
    }

    // Drift after hydration: the tree's manifests moved (a later `git`
    // absorb landed a newer package.json/lockfile into this exact working
    // tree) but the copied dependency directory never got refreshed. The
    // marker records what the directory reflected at hydration time; a
    // missing marker means this path was never stamped by our own
    // hydration (hand-installed, or hydrated before this check existed) and
    // is trusted rather than flagged.
    const marker = await readHydrationMarker(hydratedPath);
    if (
      marker !== undefined &&
      currentFingerprint !== undefined &&
      marker.fingerprint !== currentFingerprint
    ) {
      throw new Error(
        `declared dependency path is stale: ${relativePath} (project: ${projectDir}) — ` +
          "its manifests changed since this directory was last hydrated. Run the " +
          "ecosystem's install command (e.g. `npm install`) to refresh it.",
      );
    }
  }
}

export class NodeCopyPlatform implements DependencyCopyPlatform {
  async copy(source: string, destination: string): Promise<void> {
    const { cp } = await import("node:fs/promises");
    // `dereference: false` (the default) copies internal symlinks AS
    // symlinks rather than resolving and flattening them into independent
    // file copies. This matters concretely for `node_modules/.bin/*`: npm
    // installs those as relative symlinks (e.g.
    // `.bin/nest -> ../@nestjs/cli/bin/nest.js`) whose target script does a
    // relative `require("../commands")` resolved against the symlink's real
    // target directory. A dereferencing copy materializes that script as a
    // plain file directly under `.bin/`, so the same relative `require`
    // resolves one directory short and throws MODULE_NOT_FOUND — confirmed
    // for both `.bin/nest` and `.bin/tsc` in a hydrated worktree. Preserving
    // the symlink keeps the copied tree's internal relative structure
    // identical to the source's, so the shim keeps resolving correctly.
    // `verbatimSymlinks: true` stops Node's default behavior of rewriting a
    // relative symlink target into an absolute path resolved against the
    // SOURCE location — without it, the copy is still not dereferenced, but
    // every relative symlink ends up pointing back into the source tree
    // instead of the destination, defeating the point of an isolated,
    // self-contained hydrated copy.
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}
