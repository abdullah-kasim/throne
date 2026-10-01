import path from "node:path";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { shellQuote, vendoredHarnessBinaryDirectory } from "../herdr/herdr-launch-command.ts";

export const PUT_LIVE_BIN_FIRST_FUNCTION = "throne_put_live_bin_first";

export interface SessionEnvExportInput {
  liveRoot: string;
}

function putDirectoryFirstOnPathFunction(directory: string): string {
  const body = [
    `local live_entry=:${shellQuote(directory)}: remaining_path=":\${PATH}:"`,
    'while [[ $remaining_path == *"$live_entry"* ]]; do remaining_path=${remaining_path/"$live_entry"/:}; done',
    "remaining_path=${remaining_path#:}",
    "remaining_path=${remaining_path%:}",
    `export PATH=${shellQuote(directory)}\${remaining_path:+:$remaining_path}`,
  ];
  return `${PUT_LIVE_BIN_FIRST_FUNCTION}() { ${body.join("; ")}; }`;
}

export function sessionEnvExportLines({ liveRoot }: SessionEnvExportInput): string[] {
  const harnessDirectory = vendoredHarnessBinaryDirectory(liveRoot);
  return [
    `export THRONE_LIVE_ROOT=${shellQuote(liveRoot)}`,
    putDirectoryFirstOnPathFunction(path.join(liveRoot, "bin")),
    PUT_LIVE_BIN_FIRST_FUNCTION,
    `export CLAUDE_BIN=${shellQuote(path.join(harnessDirectory, HARNESS_NAMES.CLAUDE))}`,
    `export CODEX_BIN=${shellQuote(path.join(harnessDirectory, HARNESS_NAMES.CODEX))}`,
  ];
}

export type SessionEnvExportOutcome = "written" | "no-session-env-file" | "failed";

export interface SessionEnvExportContract {
  sessionEnvFile: string | undefined;
  liveRoot: () => Promise<string>;
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
    const lines = sessionEnvExportLines({ liveRoot });
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
