import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FILE_BACKED_PAYLOAD_DIR,
  type FileBackedDeliveryDeps,
} from '../src/send-agent/payload-transport.ts';

/**
 * `stagePayload` and `reapStalePayloads` write to the fixed, home-relative
 * FILE_BACKED_PAYLOAD_DIR. These deps run the REAL filesystem calls — so file
 * modes, the `wx` exclusive flag, and mtime-based reaping are genuinely
 * exercised — but rewrite that one directory prefix into a private temp root so
 * the suite never touches the operator's `~/.throne/payloads`.
 *
 * Shared by the unit suite and the submit-path integration suite so both prove
 * the same staging behaviour against one definition of the redirect.
 */
export function realDepsRootedAt(
  root: string,
  now: () => number = () => Date.now(),
): FileBackedDeliveryDeps {
  const redirect = (path: string): string => {
    if (path === FILE_BACKED_PAYLOAD_DIR) {
      return root;
    }
    if (path.startsWith(`${FILE_BACKED_PAYLOAD_DIR}/`)) {
      return join(root, path.slice(FILE_BACKED_PAYLOAD_DIR.length + 1));
    }
    return path;
  };

  return {
    mkdir: ((path: string, options: unknown) =>
      mkdir(redirect(path), options as never)) as FileBackedDeliveryDeps['mkdir'],
    writeFile: ((path: string, data: string, options: unknown) =>
      writeFile(
        redirect(path),
        data,
        options as never,
      )) as FileBackedDeliveryDeps['writeFile'],
    chmod: ((path: string, mode: number) =>
      chmod(redirect(path), mode)) as FileBackedDeliveryDeps['chmod'],
    readdir: ((path: string) =>
      readdir(redirect(path))) as FileBackedDeliveryDeps['readdir'],
    stat: ((path: string) =>
      stat(redirect(path))) as FileBackedDeliveryDeps['stat'],
    rm: ((path: string, options: unknown) =>
      rm(redirect(path), options as never)) as FileBackedDeliveryDeps['rm'],
    open: ((path: string, flags: unknown) =>
      open(redirect(path), flags as never)) as FileBackedDeliveryDeps['open'],
    now,
  };
}

/** Runs `body` against a private payload root and always tears it down. */
export async function withPayloadRoot(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'throne-payload-test-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
