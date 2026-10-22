import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeAccountsDirectory } from "./claude-account-adapter.ts";

const MCP_SERVERS_FOLDER_NAME = "mcp";
const MCP_SERVERS_KEY = "mcpServers";

export type McpServers = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readPrimaryMcpServers(primaryConfigPath: string): Promise<McpServers> {
  let source: string;
  try {
    source = await readFile(primaryConfigPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  return isRecord(parsed) && isRecord(parsed[MCP_SERVERS_KEY]) ? parsed[MCP_SERVERS_KEY] : {};
}

export function mcpServersForAccount(
  allServers: McpServers,
  isCompanyAccount: boolean,
  serversAllowedOnEveryAccount: readonly string[],
): McpServers {
  if (isCompanyAccount) return allServers;
  return Object.fromEntries(
    Object.entries(allServers).filter(([name]) => serversAllowedOnEveryAccount.includes(name)),
  );
}

export function claudeAccountMcpServersFilePath(
  accountName: string,
  environment: NodeJS.ProcessEnv,
  userHome: string,
): string {
  return path.join(claudeAccountsDirectory(environment, userHome), MCP_SERVERS_FOLDER_NAME, `${accountName}.json`);
}

export async function writeClaudeAccountMcpServersFile(filePath: string, servers: McpServers): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ [MCP_SERVERS_KEY]: servers }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
}
