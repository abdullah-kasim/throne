import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type BriefCommandResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly detail: string };

export type BriefCommandRunner = (
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMilliseconds: number,
) => Promise<BriefCommandResult>;

const execFileAsync = promisify(execFile);

function firstLineOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === "string" && stderr.trim() !== ""
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().split("\n")[0] ?? text;
}

export const runBriefCommand: BriefCommandRunner = async (file, args, cwd, timeoutMilliseconds) => {
  try {
    const { stdout } = await execFileAsync(file, [...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMilliseconds,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, detail: firstLineOf(error) };
  }
};

export interface BriefSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly trimmable: boolean;
}
