import {
  EMPTY_PROMPT,
  UNREADABLE_PAYLOAD,
  type HookSkipReason,
} from './hook-outcome.ts';
import type { RecallScopeRequest } from './recall-scope.ts';

export interface RecallRequest extends RecallScopeRequest {
  readonly taskText: string;
  readonly sessionId?: string;
  readonly transcriptPath?: string;
}

export interface SkippedHookPayload {
  readonly skipReason: HookSkipReason;
  readonly sessionId?: string;
}

const CURRENT_DIRECTORY = '.';

export function isSkippedHookPayload(
  reading: RecallRequest | SkippedHookPayload,
): reading is SkippedHookPayload {
  return 'skipReason' in reading;
}

export function recallRequestFromHookPayload(
  payloadText: string,
): RecallRequest | SkippedHookPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { skipReason: UNREADABLE_PAYLOAD };
  }
  if (typeof payload !== 'object' || payload === null) return { skipReason: UNREADABLE_PAYLOAD };
  const {
    prompt,
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
  } = payload as Record<string, unknown>;
  const session = typeof sessionId === 'string' ? { sessionId } : {};
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { skipReason: EMPTY_PROMPT, ...session };
  }
  return {
    taskText: prompt,
    ...session,
    ...(typeof transcriptPath === 'string' ? { transcriptPath } : {}),
    directories: [typeof cwd === 'string' ? cwd : CURRENT_DIRECTORY],
    memoryDirectories: [],
    includeGlobal: true,
  };
}
