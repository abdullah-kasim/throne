import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
}

export type ProcessRunner = (file: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

export interface ForgeDependencies {
  readonly fetch: typeof fetch;
  readonly runProcess: ProcessRunner;
  readonly readTailnetAddress: () => Promise<string | undefined>;
}

const PROCESS_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export const runForgeProcess: ProcessRunner = async (file, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      encoding: "utf8",
      maxBuffer: PROCESS_OUTPUT_LIMIT_BYTES,
      timeout: options.timeoutMilliseconds ?? 0,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: stderr.trim() === "" ? String(failure.message) : stderr,
    };
  }
};

async function readTailnetAddressFromTailscale(): Promise<string | undefined> {
  const result = await runForgeProcess("tailscale", ["ip", "-4"], { cwd: process.cwd() });
  const address = result.stdout.trim().split("\n")[0]?.trim() ?? "";
  return result.exitCode === 0 && address !== "" ? address : undefined;
}

export const PRODUCTION_FORGE_DEPENDENCIES: ForgeDependencies = {
  fetch: (input, init) => fetch(input, init),
  runProcess: runForgeProcess,
  readTailnetAddress: readTailnetAddressFromTailscale,
};
