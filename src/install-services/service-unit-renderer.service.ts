// The throne's own host service units: rendering templated unit sources and
// installing them as real files where the platform's service manager looks.
// `install-services` is the only caller now — `ensure-heartbeat`, which used
// to cooperatively render the keep-going pair through this same core, is
// retired (Ist campaign, 2026-08-14): throne-backend's hosted
// KeepGoingHostedWorker owns that job outright.
//
// All systemctl and filesystem access lives behind ServiceUnitDeps so every
// branch is unit-testable with fakes. launchctl is not part of that seam —
// only install-services speaks to launchd, so its runner is exported here (next
// to systemctl's, since both spawn a service-manager binary the same way) while
// the dep member lives on InstallServicesDeps.
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { THRONE_HERDR_SESSION } from "../herdr/herdr-client.ts";
import { findRepoRoot } from "../shared-policy/runtime-throne-root.ts";
/**
 * Root of the throne project, resolved structurally from the module
 * location, NEVER from cwd — the startup hook fires from arbitrary working
 * directories. See `findRepoRoot` for why this walks to a `package.json`
 * marker instead of matching on a fixed relative depth or a `dist` name.
 */
export const THRONE_ROOT = findRepoRoot(import.meta.dirname);
/** Directory holding the throne-owned systemd unit sources. */
export const SYSTEMD_SOURCE_DIR = path.join(THRONE_ROOT, "systemd");

/** Directory holding the throne-owned macOS LaunchAgent plist sources. */
export const LAUNCHD_SOURCE_DIR = path.join(THRONE_ROOT, "launchd");

/**
 * Where systemd looks for user units, honoring XDG_CONFIG_HOME with a ~/.config
 * fallback — the same rule systemd itself states. QUOTED from systemd.unit(5),
 * read on this linux box (systemd 259), Table 2 "Load path when running in user
 * mode (--user)": the row "$XDG_CONFIG_HOME/systemd/user or
 * $HOME/.config/systemd/user" is described as "User configuration
 * ($XDG_CONFIG_HOME is used if set, ~/.config otherwise)". Resolving it the same
 * way keeps our rendered files and systemctl on one directory.
 */
export const USER_UNIT_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "systemd",
  "user",
);

/**
 * Where launchd looks for the current user's agents. Quoted from
 * launchd.plist(5) (Darwin, dated 30 July 2019), FILES:
 * "~/Library/LaunchAgents  Per-user agents provided by the user."
 * Unlike USER_UNIT_DIR, no environment override appears there, so this constant
 * builds the one documented form.
 */
export const LAUNCH_AGENTS_DIR = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
);

/** The absolute throne path substituted into unit sources at install time. */
export const THRONE_ROOT_TOKEN = "{{THRONE_ROOT}}";

/** The absolute herdr binary path substituted into unit sources at install time. */
export const HERDR_BIN_TOKEN = "{{HERDR_BIN}}";

/**
 * The absolute node interpreter path substituted into unit sources at
 * install time — the mise `lts` symlink form, never a version-pinned path.
 */
export const NODE_BIN_TOKEN = "{{NODE_BIN}}";

export const SERVICE_MANAGER_EXECUTABLES = {
  SYSTEMCTL: "systemctl",
  LAUNCHCTL: "launchctl",
} as const;

export const SYSTEMD_UNIT_NAMES = {
  BUILD_SERVICE: "throne-build.service",
  HERDR_SERVER: "herdr-server.service",
  NTFY: "ntfy.service",
  KEEP_GOING_SERVICE: "throne-keep-going.service",
  KEEP_GOING_TIMER: "throne-keep-going.timer",
  NO_IDLING_SERVICE: "throne-no-idling.service",
  NO_IDLING_TIMER: "throne-no-idling.timer",
  THRONE_WORK: "throne-work.service",
  THRONE_BACKEND: "throne-backend.service",
  THRONE_HERDR: "throne-herdr.service",
  SWEEP_TMP_SCRATCH_HOME_SERVICE: "sweep-tmp-scratch-home.service",
  SWEEP_TMP_SCRATCH_HOME_TIMER: "sweep-tmp-scratch-home.timer",
  SWEEP_TMP_SCRATCH_SLASH_SERVICE: "sweep-tmp-scratch-slash.service",
  SWEEP_TMP_SCRATCH_SLASH_TIMER: "sweep-tmp-scratch-slash.timer",
  SWEEP_TMP_SCRATCH_CLAUDE1000_SERVICE: "sweep-tmp-scratch-claude1000.service",
  SWEEP_TMP_SCRATCH_CLAUDE1000_TIMER: "sweep-tmp-scratch-claude1000.timer",
} as const;

export const LAUNCHD_AGENT_NAMES = {
  HERDR_SERVER: {
    basename: "com.throne.herdr-server.plist",
    label: "com.throne.herdr-server",
  },
  NTFY: {
    basename: "com.throne.ntfy.plist",
    label: "com.throne.ntfy",
  },
  KEEP_GOING: {
    basename: "com.throne.keep-going.plist",
    label: "com.throne.keep-going",
  },
  NO_IDLING: {
    basename: "com.throne.no-idling.plist",
    label: "com.throne.no-idling",
  },
  THRONE_BACKEND: {
    basename: "com.throne.throne-backend.plist",
    label: "com.throne.throne-backend",
  },
  THRONE_HERDR: {
    basename: "com.throne.throne-herdr.plist",
    label: "com.throne.throne-herdr",
  },
} as const;

export const HERDR_SERVER_SESSION_ARGUMENTS = [
  "--session",
  THRONE_HERDR_SESSION,
  "server",
] as const;

/** Any `{{...}}` left after substitution — an unresolved token, never shippable. */
const LEFTOVER_TOKEN = /\{\{[^}\n]*\}\}/;

/**
 * Sentinel exit code `runServiceManager` below synthesizes when the binary
 * can't be spawned at all (e.g. ENOENT), because Node reports a spawn failure
 * as a string `error.code` rather than a numeric status.
 *
 * 127 does not collide with systemctl: systemctl(1) EXIT STATUS, read on this
 * host (systemd 259), says "systemctl uses the return codes defined by LSB, as
 * defined in LSB 3.0.0", and the table under it runs 0..4. On the launchctl
 * side it is OUR convention only — launchctl(1) (read from published Darwin
 * man-page mirrors, never from a mac) enumerates no bounded set of codes, so a
 * real launchctl exiting 127 would be read as "launchctl absent".
 *
 * What the sentinel means is per-platform and per-caller: on linux a missing
 * systemctl is a graceful skip, on mac a missing launchctl is a broken host.
 */
export const SERVICE_MANAGER_ABSENT = 127;

/** Matches systemctl's "no user manager / D-Bus" family of failures. */
const BUS_UNREACHABLE = /failed to connect to [^\n]*bus/i;

/** Result of one service-manager invocation — a plain value, never a throw. */
export interface ServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** True when systemctl can't be reached at all (absent binary or no user bus). */
export function isSystemdUnavailable(probe: ServiceCommandResult): boolean {
  return (
    probe.code === SERVICE_MANAGER_ABSENT || BUS_UNREACHABLE.test(probe.stderr)
  );
}

/** What currently occupies an installed unit path. */
export type InstalledUnitKind = "missing" | "file" | "symlink";

/** The installed path's kind plus its content (empty unless kind is 'file'). */
export interface InstalledUnit {
  kind: InstalledUnitKind;
  content: string;
}

/** Values substituted into a unit source; a null value leaves its token unresolved. */
export interface UnitTokens {
  throneRoot: string;
  herdrBin: string | null;
  /** The resolved mise `lts` node interpreter path; only the systemd units that call node directly use it. */
  nodeBin?: string | null;
}

/** One unit to render and install. */
export interface UnitInstallRequest {
  sourcePath: string;
  targetPath: string;
  tokens: UnitTokens;
  /** When true, compute the outcome exactly as a real run would but write nothing. */
  dryRun: boolean;
}

/** What installing one unit did (or, under dryRun, would do). */
export type UnitInstallAction =
  "unchanged" | "created" | "updated" | "replaced-symlink" | "error";

export interface UnitInstallOutcome {
  basename: string;
  targetPath: string;
  action: UnitInstallAction;
  /** True when the installed content differs from what was there before. */
  changed: boolean;
  /** Populated only when action is 'error'. */
  message?: string;
}

/**
 * Injectable seam over systemd + the filesystem — defaults to
 * REAL_SERVICE_UNIT_DEPS; tests supply fakes to drive every branch without
 * touching real systemctl or the real FS.
 */
export interface ServiceUnitDeps {
  systemctl(args: string[]): Promise<ServiceCommandResult>;
  readUnitSource(sourcePath: string): Promise<string>;
  inspectInstalledUnit(targetPath: string): Promise<InstalledUnit>;
  writeUnitFile(targetPath: string, content: string): Promise<void>;
}

/**
 * Run a service-manager binary: spawn failures resolve as
 * SERVICE_MANAGER_ABSENT, not throws, so every caller branches on a value.
 */
function runServiceManager(
  binary: string,
  args: string[],
): Promise<ServiceCommandResult> {
  return new Promise((resolve) => {
    execFile(binary, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        // A non-zero exit sets error.code to the numeric status; a spawn
        // failure (binary absent) sets it to a string like 'ENOENT'.
        if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
        } else {
          resolve({
            code: SERVICE_MANAGER_ABSENT,
            stdout,
            stderr: error.message,
          });
        }
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  });
}

/**
 * Exported so `SelfRebuildHostedWorker` (`src/throne-backend/self-rebuild.hosted-worker.ts`)
 * can issue its own `systemctl --user restart throne-backend.service` through
 * the exact same spawn plumbing install-services uses, rather than
 * hand-rolling a second `execFile` call over `systemctl`.
 */
export function runSystemctl(args: string[]): Promise<ServiceCommandResult> {
  return runServiceManager(SERVICE_MANAGER_EXECUTABLES.SYSTEMCTL, args);
}

/**
 * Real launchctl runner, for the mac half of install-services. Never exercised
 * on this project's hosts — no macOS box exists here — so only its dep-injected
 * callers are proven; the spawn plumbing is the same one systemctl uses.
 */
export function runLaunchctl(args: string[]): Promise<ServiceCommandResult> {
  return runServiceManager(SERVICE_MANAGER_EXECUTABLES.LAUNCHCTL, args);
}

/** Classify (and read) whatever currently occupies an installed unit path. */
async function realInspectInstalledUnit(
  targetPath: string,
): Promise<InstalledUnit> {
  let entry;
  try {
    entry = await lstat(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", content: "" };
    }
    throw err;
  }
  if (entry.isSymbolicLink()) {
    // Never our rendered file, whatever it points at — always replaced.
    return { kind: "symlink", content: "" };
  }
  if (!entry.isFile()) {
    // Anything else (a directory, a socket) holds none of our content; report
    // empty so the caller tries the write and fails loudly if it can't.
    return { kind: "file", content: "" };
  }
  return { kind: "file", content: await readFile(targetPath, "utf8") };
}

/**
 * Write a rendered unit as a plain 0644 REAL file, removing whatever was there
 * first so a pre-existing symlink is replaced rather than written through.
 */
async function realWriteUnitFile(
  targetPath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rm(targetPath, { force: true });
  await writeFile(targetPath, content, { encoding: "utf8", mode: 0o644 });
}

export const REAL_SERVICE_UNIT_DEPS: ServiceUnitDeps = {
  systemctl: runSystemctl,
  readUnitSource: (sourcePath) => readFile(sourcePath, "utf8"),
  inspectInstalledUnit: realInspectInstalledUnit,
  writeUnitFile: realWriteUnitFile,
};

/**
 * Substitute the install-time tokens into a unit source. A source with no tokens
 * renders verbatim. Throws naming the first token still unresolved afterwards —
 * an unrendered `{{...}}` in a unit file is a broken service, never a warning.
 */
export function renderUnitSource(source: string, tokens: UnitTokens): string {
  const substitutions: ReadonlyArray<readonly [string, string | null]> = [
    [THRONE_ROOT_TOKEN, tokens.throneRoot],
    [HERDR_BIN_TOKEN, tokens.herdrBin],
    [NODE_BIN_TOKEN, tokens.nodeBin ?? null],
  ];
  let rendered = source;
  for (const [token, value] of substitutions) {
    if (value !== null) {
      rendered = rendered.replaceAll(token, value);
    }
  }
  const leftover = LEFTOVER_TOKEN.exec(rendered);
  if (leftover !== null) {
    throw new Error(`unresolved template token ${leftover[0]}`);
  }
  return rendered;
}

/** Render one unit source and install it, reporting what it did to the target path. */
export async function installUnitFile(
  deps: ServiceUnitDeps,
  request: UnitInstallRequest,
): Promise<UnitInstallOutcome> {
  const basename = path.basename(request.targetPath);
  const base = { basename, targetPath: request.targetPath };
  let rendered: string;
  let installed: InstalledUnit;
  try {
    rendered = renderUnitSource(
      await deps.readUnitSource(request.sourcePath),
      request.tokens,
    );
    installed = await deps.inspectInstalledUnit(request.targetPath);
  } catch (err) {
    return {
      ...base,
      action: "error",
      changed: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (installed.kind === "file" && installed.content === rendered) {
    return { ...base, action: "unchanged", changed: false };
  }
  const action: UnitInstallAction =
    installed.kind === "missing"
      ? "created"
      : installed.kind === "symlink"
        ? "replaced-symlink"
        : "updated";
  if (!request.dryRun) {
    try {
      await deps.writeUnitFile(request.targetPath, rendered);
    } catch (err) {
      return {
        ...base,
        action: "error",
        changed: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ...base, action, changed: true };
}

/** Install several units in order, reporting each one's outcome independently. */
export async function installUnitFiles(
  deps: ServiceUnitDeps,
  requests: readonly UnitInstallRequest[],
): Promise<UnitInstallOutcome[]> {
  const outcomes: UnitInstallOutcome[] = [];
  for (const request of requests) {
    outcomes.push(await installUnitFile(deps, request));
  }
  return outcomes;
}

export class ServiceUnitRenderer {
  render(source: string, tokens: UnitTokens): string {
    return renderUnitSource(source, tokens);
  }
}
