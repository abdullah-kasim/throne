// Where the Claude OAuth credentials live is platform-shaped: Linux Claude Code
// writes `~/.claude/.credentials.json`; macOS Claude Code writes the SAME JSON
// document into the login Keychain (service "Claude Code-credentials") and
// leaves no file behind. The parser downstream never cares which, so this
// module owns only the read: file first, then — on ENOENT, on darwin only —
// the Keychain via `security find-generic-password -w`. Any other file error
// is a real failure and is rethrown as-is.
//
// The secret is returned to the caller and nowhere else: never logged, never
// written, never echoed into an error message.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

export interface ClaudeCredentialSourceDeps {
  readFile: (path: string) => Promise<string>;
  readKeychainItem: (service: string) => Promise<string>;
  platform: NodeJS.Platform;
}

export async function realReadKeychainItem(service: string): Promise<string> {
  const run = promisify(execFile);
  const { stdout } = await run('security', ['find-generic-password', '-s', service, '-w'], {
    timeout: KEYCHAIN_READ_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return stdout.trim();
}

export const REAL_CLAUDE_CREDENTIAL_DEPS: ClaudeCredentialSourceDeps = {
  readFile: (path) => readFile(path, 'utf8'),
  readKeychainItem: realReadKeychainItem,
  platform: process.platform,
};

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Raw credentials JSON: the file when present, the darwin Keychain when the
 *  file is absent, and a failure naming BOTH attempts otherwise. */
export async function readClaudeCredentialsRaw(
  credentialsPath: string,
  deps: ClaudeCredentialSourceDeps = REAL_CLAUDE_CREDENTIAL_DEPS,
): Promise<string> {
  let fileError: unknown;
  try {
    return await deps.readFile(credentialsPath);
  } catch (error) {
    fileError = error;
  }
  if (!isEnoent(fileError) || deps.platform !== 'darwin') {
    throw fileError;
  }
  try {
    return await deps.readKeychainItem(CLAUDE_KEYCHAIN_SERVICE);
  } catch (keychainError) {
    throw new Error(
      `file ${credentialsPath}: ${errText(fileError)}; keychain "${CLAUDE_KEYCHAIN_SERVICE}": ${errText(keychainError)}`,
    );
  }
}
