import {
  consumePayload,
  type PayloadConsumptionOutcome,
} from './payload-consumption.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';

function writeReadPayloadRefusal(deps: ReadPayloadDeps, reason: string): void {
  deps.stderr(
    `${renderEntranceRefusal({
      reason,
      bypass: undefined,
      supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
    })}\n`,
  );
}

export const READ_PAYLOAD_EXIT = {
  SUCCESS: 0,
  USAGE: 64,
  MISSING: 2,
  UNREADABLE: 3,
  CLEANUP_FAILED: 4,
  INVALID_PATH: 5,
} as const;

export interface ReadPayloadDeps {
  consumePayload: (path: string) => Promise<PayloadConsumptionOutcome>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const REAL_DEPS: ReadPayloadDeps = {
  consumePayload,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runReadPayload(
  args: string[],
  deps: ReadPayloadDeps = REAL_DEPS,
): Promise<number> {
  if (args.length !== 1 || args[0] === undefined) {
    deps.stderr(
      'read-payload: exactly one absolute payload path is required. ' +
        'Usage: ./bin/throne-cli read-payload <absolute-payload-path>\n',
    );
    writeReadPayloadRefusal(
      deps,
      'read-payload entrance validation requires exactly one absolute payload path.',
    );
    return READ_PAYLOAD_EXIT.USAGE;
  }

  const outcome = await deps.consumePayload(args[0]);
  switch (outcome.kind) {
    case 'success':
      deps.stdout(outcome.body);
      deps.stderr(
        `read-payload: consumed ${outcome.byteLength} bytes, sha512 ` +
          `${outcome.sha512}; deleted ${outcome.path}\n`,
      );
      return READ_PAYLOAD_EXIT.SUCCESS;
    case 'missing':
      deps.stderr(`read-payload: payload missing at read time: ${outcome.path}\n`);
      return READ_PAYLOAD_EXIT.MISSING;
    case 'unreadable':
      deps.stderr(
        `read-payload: payload unreadable at read time: ${outcome.path} ` +
          `(${outcome.error})\n`,
      );
      return READ_PAYLOAD_EXIT.UNREADABLE;
    case 'cleanup-failed':
      deps.stderr(
        `read-payload: payload read completely but deletion failed: ` +
          `${outcome.path} (${outcome.error}); body withheld from stdout\n`,
      );
      return READ_PAYLOAD_EXIT.CLEANUP_FAILED;
    case 'invalid-path':
      deps.stderr(
        `read-payload: refused path outside the throne payload directory: ` +
          `${outcome.path}\n`,
      );
      writeReadPayloadRefusal(
        deps,
        'read-payload refused a path outside the throne payload directory.',
      );
      return READ_PAYLOAD_EXIT.INVALID_PATH;
  }
}
