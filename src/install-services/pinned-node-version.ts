import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MISE_CONFIG_FILE_NAME = 'mise.toml';
const TOOLS_TABLE_HEADER = '[tools]';
const NODE_PIN_LINE = /^node\s*=\s*"([^"]+)"$/;

function isTableHeader(line: string): boolean {
  return line.startsWith('[');
}

function nodeVersionInToolsTable(miseConfig: string): string | null {
  let insideToolsTable = false;
  for (const line of miseConfig.split('\n').map((rawLine) => rawLine.trim())) {
    if (isTableHeader(line)) {
      insideToolsTable = line === TOOLS_TABLE_HEADER;
      continue;
    }
    const nodePin = insideToolsTable ? NODE_PIN_LINE.exec(line) : null;
    if (nodePin !== null) {
      return nodePin[1];
    }
  }
  return null;
}

export function readPinnedNodeVersion(throneRoot: string): string | null {
  const miseConfigPath = path.join(throneRoot, MISE_CONFIG_FILE_NAME);
  if (!existsSync(miseConfigPath)) {
    return null;
  }
  return nodeVersionInToolsTable(readFileSync(miseConfigPath, 'utf8'));
}
