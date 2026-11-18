import { Command, CommandRunner } from "nest-commander";
import { text as readStreamAsText } from "node:stream/consumers";
import { THRONE_DATA_DIR } from "../shared-policy/throne-home.ts";
import { TAB_AGENT_NAME_VARIABLE, refreshStagerTreeForPrompt } from "./stager-tree-refresh.ts";

export interface RefreshStagerTreeDependencies {
  readStdin(): Promise<string>;
  readonly agentLedgerDirectory: string;
  readonly tabAgentName: string | undefined;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: RefreshStagerTreeDependencies = {
  readStdin: () => readStreamAsText(process.stdin),
  agentLedgerDirectory: THRONE_DATA_DIR,
  get tabAgentName() {
    return process.env[TAB_AGENT_NAME_VARIABLE];
  },
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

function promptDirectoryOf(payloadText: string): string {
  const payload: unknown = JSON.parse(payloadText);
  const cwd = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).cwd : undefined;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

export async function runRefreshStagerTree(
  dependencies: RefreshStagerTreeDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  try {
    const line = await refreshStagerTreeForPrompt({
      agentName: dependencies.tabAgentName,
      agentLedgerDirectory: dependencies.agentLedgerDirectory,
      promptDirectory: promptDirectoryOf(await dependencies.readStdin()),
    });
    if (line !== undefined) dependencies.writeStdout(`${line}\n`);
  } catch (error) {
    dependencies.writeStderr(
      `refresh-stager-tree: the Stager checkout could not be refreshed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return 0;
}

@Command({ name: "refresh-stager-tree" })
export class RefreshStagerTreeCommand extends CommandRunner {
  async run(): Promise<void> {
    process.exitCode = await runRefreshStagerTree();
  }
}
