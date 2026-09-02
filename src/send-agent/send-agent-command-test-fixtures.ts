import { MessageQueueWorkItemState } from "../message-queue/message-queue.store.ts";

/**
 * Shared by the `send-agent` and `send-agent-legacy` command test suites.
 */
export interface FakeQueueStore {
  readonly inserted: { kind: string; payload: unknown }[];
  readHeartbeat(): number | undefined;
  listUnacknowledgedDeliveryFailureNotices(senderName: string): unknown[];
  insertWorkItem(item: { kind: string; payload: unknown }): {
    id: number;
    kind: string;
    payload: unknown;
    state: string;
    failureReason: null;
    createdAt: number;
    updatedAt: number;
  };
  close(): void;
}

export function fakeQueueStore(
  heartbeat: number | undefined,
  unacknowledgedNotices: unknown[] = [],
): FakeQueueStore {
  const inserted: FakeQueueStore["inserted"] = [];
  let nextId = 1;
  return {
    inserted,
    readHeartbeat: () => heartbeat,
    listUnacknowledgedDeliveryFailureNotices: () => unacknowledgedNotices,
    insertWorkItem: (item) => {
      inserted.push(item);
      return {
        id: nextId++,
        kind: item.kind,
        payload: item.payload,
        state: MessageQueueWorkItemState.Queued,
        failureReason: null,
        createdAt: 0,
        updatedAt: 0,
      };
    },
    close: () => {},
  };
}

/**
 * Captures a `send-agent`-family command's stdout/stderr/exit status for one
 * `run()` call, restoring the ambient process state afterward.
 */
export async function captureRun<Command extends { run(args: string[]): Promise<void> }>(
  args: string[],
  command: Command,
  ambientExitCode = 73,
): Promise<{ stderr: string; stdout: string; status: number }> {
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = ambientExitCode;
  try {
    await command.run(args);
    return { stderr, stdout, status: Number(process.exitCode ?? 0) };
  } finally {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
  }
}
