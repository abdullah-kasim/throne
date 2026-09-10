import path from "node:path";
import { shellQuote } from "../herdr/herdr-launch-command.ts";

export interface SessionEnvExportInput {
  liveRoot: string;
  currentPath: string | undefined;
}

export function sessionEnvExportLines({ liveRoot, currentPath }: SessionEnvExportInput): string[] {
  const shimDir = path.join(liveRoot, "bin");
  const lines = [`export THRONE_LIVE_ROOT=${shellQuote(liveRoot)}`];
  const alreadyOnPath = (currentPath ?? "")
    .split(path.delimiter)
    .some((entry) => entry === shimDir);
  if (!alreadyOnPath) {
    lines.push(`export PATH=${shellQuote(shimDir)}:"$PATH"`);
  }
  return lines;
}

export type SessionEnvExportOutcome = "written" | "no-session-env-file" | "failed";

export interface SessionEnvExportContract {
  sessionEnvFile: string | undefined;
  liveRoot: () => Promise<string>;
  currentPath: string | undefined;
  appendToFile: (file: string, text: string) => Promise<void>;
  writeStderr: (text: string) => void;
}

export async function exportGitShimToSession(
  contract: SessionEnvExportContract,
): Promise<SessionEnvExportOutcome> {
  if (contract.sessionEnvFile === undefined || contract.sessionEnvFile === "") {
    return "no-session-env-file";
  }
  try {
    const liveRoot = await contract.liveRoot();
    const lines = sessionEnvExportLines({ liveRoot, currentPath: contract.currentPath });
    await contract.appendToFile(contract.sessionEnvFile, `${lines.join("\n")}\n`);
    return "written";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    contract.writeStderr(
      `throne-startup: could not export the git shim onto this session's PATH (${message}); commits from this session will not be identity-guarded\n`,
    );
    return "failed";
  }
}
