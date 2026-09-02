import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { errorText } from '../shared-policy/error-text.ts';

export const FILE_BACKED_PAYLOAD_DIR = join(homedir(), '.throne', 'payloads');

export interface PayloadConsumptionDeps {
  readFile: typeof readFile;
  rm: typeof rm;
}

export const REAL_PAYLOAD_CONSUMPTION_DEPS: PayloadConsumptionDeps = {
  readFile,
  rm,
};


function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isMissingError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isOwnedPayloadPath(path: string): boolean {
  const resolvedPath = resolve(path);
  return (
    path === resolvedPath &&
    dirname(resolvedPath) === resolve(FILE_BACKED_PAYLOAD_DIR) &&
    basename(resolvedPath).endsWith('.payload.txt')
  );
}

export type PayloadConsumptionOutcome =
  | {
      kind: 'success';
      path: string;
      body: string;
      byteLength: number;
      sha512: string;
    }
  | { kind: 'missing'; path: string }
  | { kind: 'unreadable'; path: string; error: string }
  | { kind: 'cleanup-failed'; path: string; error: string }
  | { kind: 'invalid-path'; path: string };

/** Reads one owned payload completely, then deletes it. */
export async function consumePayload(
  path: string,
  deps: PayloadConsumptionDeps = REAL_PAYLOAD_CONSUMPTION_DEPS,
): Promise<PayloadConsumptionOutcome> {
  if (!isOwnedPayloadPath(path)) {
    return { kind: 'invalid-path', path };
  }

  let bytes: Buffer;
  try {
    bytes = await deps.readFile(path);
  } catch (error) {
    if (isMissingError(error)) {
      return { kind: 'missing', path };
    }
    return { kind: 'unreadable', path, error: errorText(error) };
  }

  try {
    await deps.rm(path);
  } catch (error) {
    return { kind: 'cleanup-failed', path, error: errorText(error) };
  }

  return {
    kind: 'success',
    path,
    body: bytes.toString('utf8'),
    byteLength: bytes.byteLength,
    sha512: createHash('sha512').update(bytes).digest('hex'),
  };
}
