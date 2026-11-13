import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, constants, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";

const runFile = promisify(execFile);
const VERSION_TIMEOUT_MS = 20_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const INSTALLER_STEP = "./install.sh --harnesses-only";

export interface JscpdCheck {
  pinned: string;
  vendoredPath: string;
  shimPath: string;
  vendored?: string;
  vendoredExists: boolean;
  onPath?: string;
  pathReachesShim: boolean;
  matches: boolean;
}

export async function readJscpdPin(throneRoot: string = RUNTIME_THRONE_ROOT): Promise<string> {
  const pinsPath = path.join(throneRoot, "vendor-pins.json");
  const pins = JSON.parse(await readFile(pinsPath, "utf8")) as { harnesses?: { jscpd?: { version?: unknown } } };
  const version = pins.harnesses?.jscpd?.version;
  if (typeof version !== "string") throw new Error(`${pinsPath} has no harnesses.jscpd version`);
  return version;
}

export function parseJscpdVersion(versionOutput: string): string | undefined {
  const lastToken = versionOutput.trim().split(/\s+/).at(-1) ?? "";
  return VERSION_PATTERN.test(lastToken) ? lastToken : undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(executable: string, searchPath: string): Promise<string | undefined> {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isSameFile(first: string, second: string): Promise<boolean> {
  try {
    return (await realpath(first)) === (await realpath(second));
  } catch {
    return false;
  }
}

async function versionOf(executablePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runFile(executablePath, ["--version"], { timeout: VERSION_TIMEOUT_MS });
    return parseJscpdVersion(stdout);
  } catch {
    return undefined;
  }
}

export function callerSearchPath(
  searchPath: string = process.env.PATH ?? "",
  pinnedNodeDirectory: string = path.dirname(process.execPath),
): string {
  const [first, ...rest] = searchPath.split(path.delimiter);
  return realDirectory(first) === realDirectory(pinnedNodeDirectory) ? rest.join(path.delimiter) : searchPath;
}

function realDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

export async function checkJscpd(
  throneRoot: string = RUNTIME_THRONE_ROOT,
  searchPath: string = callerSearchPath(),
): Promise<JscpdCheck> {
  const pinned = await readJscpdPin(throneRoot);
  const vendoredPath = path.join(throneRoot, "vendor", "node_modules", ".bin", "jscpd");
  const shimPath = path.join(throneRoot, "bin", "jscpd");
  const vendoredExists = await isExecutable(vendoredPath);
  const vendored = vendoredExists ? await versionOf(vendoredPath) : undefined;
  const onPath = await findOnPath("jscpd", searchPath);
  const pathReachesShim = onPath !== undefined && (await isSameFile(onPath, shimPath));
  return {
    pinned,
    vendoredPath,
    shimPath,
    vendored,
    vendoredExists,
    onPath,
    pathReachesShim,
    matches: vendored === pinned && pathReachesShim,
  };
}

export function renderJscpdCheck(check: JscpdCheck): string {
  const lines = [
    `pinned: ${check.pinned}`,
    `vendored: ${check.vendored ?? (check.vendoredExists ? "unreadable version" : "missing")} (${check.vendoredPath})`,
    `jscpd on PATH: ${check.onPath ?? "not found"}`,
  ];
  if (check.vendored !== check.pinned) {
    lines.push(`the vendored jscpd is not the pinned ${check.pinned}; run ${INSTALLER_STEP}`);
  }
  if (!check.pathReachesShim) {
    lines.push(
      check.onPath === undefined
        ? `jscpd is not on PATH; put ${path.dirname(check.shimPath)} first on PATH`
        : `a different jscpd comes first on PATH: ${check.onPath}; it must be ${check.shimPath}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function run(): Promise<number> {
  const check = await checkJscpd();
  process.stdout.write(renderJscpdCheck(check));
  return check.matches ? 0 : 1;
}
