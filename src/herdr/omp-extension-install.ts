import { mkdir, lstat, readlink, symlink, unlink, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Installs the throne's omp delivery extension into omp's own extension
 * directory, as a symlink back into the checkout.
 *
 * WHY A SYMLINK. The extension must track the throne it belongs to. A copy
 * goes stale silently the moment the checkout moves forward, and a stale
 * delivery protocol is the failure this whole feature exists to remove. A
 * symlink cannot drift: whatever the throne is running is what omp loads at
 * its next session start.
 *
 * WHERE, AND HOW IT IS DETECTED. Not by finding an `omp` binary. The binary
 * may live anywhere (`~/.bun/bin/omp` on this host) and need not be on the
 * PATH of whatever process runs startup — a systemd user unit has a
 * famously thin PATH, and "no omp on PATH" would then mean "silently never
 * install", which is exactly the kind of quiet no-op that hides for weeks.
 *
 * We are not launching omp; we are writing into its configuration. So the
 * FIRST probe is the thing we actually need: does omp's agent directory
 * exist? It is created by omp on first run, so its presence is positive
 * evidence that omp is set up for this user.
 *
 * BELT AND SUSPENDERS: an executable probe backs it up, because the two
 * failure modes are different and neither covers the other.
 *
 *   agent dir, no binary on PATH   omp is installed and used; the caller
 *                                  simply has a thin PATH (a systemd user
 *                                  unit). Install anyway.
 *   binary, no agent dir           omp is installed but has never been run,
 *                                  so nothing has created its config yet.
 *   neither                        omp genuinely is not here. Do nothing,
 *                                  and say so.
 *
 * The executable probe checks PATH and then a short list of the places
 * user-level installers actually put things — `~/.bun/bin` first, since that
 * is where the bun-run `omp` script lands. Finding the binary is enough to
 * justify CREATING the agent directory: an extension waiting for omp's first
 * run is correct, and costs one symlink.
 */
export const OMP_AGENT_DIR_ENV = "OMP_AGENT_DIR";
export const INSTALLED_EXTENSION_NAME = "throne-omp-delivery.ts";

/** Directories user-level installers actually use, checked after PATH. */
const OMP_FALLBACK_BINARY_DIRECTORIES: readonly string[] = [
  ".bun/bin",
  ".local/bin",
  ".cargo/bin",
  "bin",
];

/** The `omp` executable's path, or undefined when none is findable. */
export async function findOmpExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const entry of (environment.PATH ?? "").split(path.delimiter)) {
    if (entry.trim() !== "") candidates.push(path.join(entry, "omp"));
  }
  for (const relative of OMP_FALLBACK_BINARY_DIRECTORIES) {
    candidates.push(path.join(home, relative, "omp"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export function ompAgentDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configured = environment[OMP_AGENT_DIR_ENV]?.trim();
  return configured && configured !== ""
    ? path.resolve(configured)
    : path.join(home, ".omp", "agent");
}

export type OmpExtensionInstallOutcome =
  /** omp is not set up for this user; nothing to install into. */
  | { readonly kind: "omp-absent"; readonly probed: string }
  /** No agent directory yet, but an omp binary exists — directory created. */
  | { readonly kind: "installed-ahead-of-first-run"; readonly link: string; readonly executable: string }
  /** The symlink already pointed at this exact source. */
  | { readonly kind: "already-current"; readonly link: string }
  /** Created, or repointed from a stale/foreign target. */
  | { readonly kind: "installed"; readonly link: string; readonly replaced?: string }
  /**
   * Something is in the way that we will not silently destroy — a real file,
   * or a directory. Reported rather than removed: an operator may have put a
   * hand-written extension there, and deleting somebody's code to install our
   * own is not a repair.
   */
  | { readonly kind: "blocked"; readonly link: string; readonly reason: string };

export interface OmpExtensionInstallDeps {
  readonly agentDir?: string;
  /** Absolute path of the extension source inside the checkout. */
  readonly source: string;
  /** Injectable for tests; defaults to the PATH + well-known-directory probe. */
  readonly findExecutable?: () => Promise<string | undefined>;
}

async function pathKind(
  target: string,
): Promise<"absent" | "symlink" | "other"> {
  try {
    const stats = await lstat(target);
    return stats.isSymbolicLink() ? "symlink" : "other";
  } catch {
    return "absent";
  }
}

export async function installOmpDeliveryExtension(
  deps: OmpExtensionInstallDeps,
): Promise<OmpExtensionInstallOutcome> {
  const agentDir = deps.agentDir ?? ompAgentDirectory();
  let aheadOfFirstRun: string | undefined;
  if ((await pathKind(agentDir)) === "absent") {
    const executable = await (deps.findExecutable ?? findOmpExecutable)();
    if (executable === undefined) {
      return { kind: "omp-absent", probed: agentDir };
    }
    // Installed but never run. Create the config directory ourselves so the
    // extension is already in place at omp's first session, rather than
    // waiting for a second startup to notice.
    await mkdir(agentDir, { recursive: true });
    aheadOfFirstRun = executable;
  }
  const extensionsDir = path.join(agentDir, "extensions");
  // omp creates this on demand; the agent dir existing without it is normal
  // for a user who has never installed an extension.
  await mkdir(extensionsDir, { recursive: true });
  const link = path.join(extensionsDir, INSTALLED_EXTENSION_NAME);

  const kind = await pathKind(link);
  if (kind === "other") {
    return {
      kind: "blocked",
      link,
      reason:
        "a real file or directory already occupies that path; refusing to " +
        "delete it. Move it aside if the throne should own this name.",
    };
  }
  if (kind === "symlink") {
    let current: string | undefined;
    try {
      current = await readlink(link);
    } catch {
      current = undefined;
    }
    if (current !== undefined && path.resolve(current) === path.resolve(deps.source)) {
      return { kind: "already-current", link };
    }
    await unlink(link);
    await symlink(deps.source, link);
    return { kind: "installed", link, ...(current === undefined ? {} : { replaced: current }) };
  }
  await symlink(deps.source, link);
  return aheadOfFirstRun === undefined
    ? { kind: "installed", link }
    : { kind: "installed-ahead-of-first-run", link, executable: aheadOfFirstRun };
}

/** One line for the startup log; every outcome is stated, including the
 *  no-op, so "omp support did nothing today" is never silent. */
export function describeOmpExtensionInstall(
  outcome: OmpExtensionInstallOutcome,
): string {
  switch (outcome.kind) {
    case "omp-absent":
      return `omp delivery extension: not installed — no omp agent directory at ${outcome.probed}`;
    case "already-current":
      return `omp delivery extension: already current at ${outcome.link}`;
    case "installed":
      return outcome.replaced === undefined
        ? `omp delivery extension: installed at ${outcome.link}`
        : `omp delivery extension: repointed ${outcome.link} (was -> ${outcome.replaced})`;
    case "installed-ahead-of-first-run":
      return `omp delivery extension: installed at ${outcome.link} — omp found at ${outcome.executable} but never run, so its agent directory was created`;
    case "blocked":
      return `omp delivery extension: BLOCKED at ${outcome.link} — ${outcome.reason}`;
  }
}
