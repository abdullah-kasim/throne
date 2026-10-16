import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AgentHistoryFile<History> {
  readonly read: (agentName: string) => Promise<History | null>;
  readonly write: (agentName: string, history: History) => Promise<void>;
}

export function agentHistoryFileUnder<History>(
  agentDataRoot: string,
  basename: string,
  isHistory: (value: unknown) => value is History,
): AgentHistoryFile<History> {
  const historyPath = (agentName: string): string =>
    path.join(agentDataRoot, agentName, basename);
  return {
    read: async (agentName) => {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(historyPath(agentName), "utf8"),
        );
        return isHistory(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write: async (agentName, history) => {
      await mkdir(path.dirname(historyPath(agentName)), { recursive: true });
      await writeFile(
        historyPath(agentName),
        `${JSON.stringify(history, null, 2)}\n`,
        "utf8",
      );
    },
  };
}
