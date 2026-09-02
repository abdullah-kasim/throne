import {
  SubmitAssumedFilledError,
  SubmitNotSentError,
} from "../herdr/herdr-send.types.ts";

/**
 * How many times a pre-write `SubmitNotSentError` refusal may be retried
 * before the item terminal-fails. `SubmitNotSentError` is provably safe to
 * retry (nothing was ever written to the pane); this bounds it so a
 * persistently unreachable recipient still terminal-fails instead of
 * retrying forever.
 */
export const MAX_NOT_SENT_RETRY_ATTEMPTS = 3;

/** Delay between a retry-safe attempt and the next one. */
export const NOT_SENT_RETRY_BACKOFF_MS = 200;

export type SubmitAttemptOutcome =
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "terminal-fail"; readonly reason: string };

/**
 * The single safety-critical boundary of this slice: `SubmitNotSentError` is
 * retry-safe (a pre-write refusal — nothing was typed) up to a bounded
 * count; `SubmitAssumedFilledError` — text may already be resident or
 * pending — is NEVER retried, terminal-failing immediately with its reason.
 * Any other thrown error is treated the same as assumed-filled: an unreadable
 * observation is retried by looking again, never by inventing a third
 * verdict, so once looks run out (or the failure is of an unknown shape)
 * the composer is assumed filled and never earns a resend.
 */
export function classifySubmitAttemptError(
  error: unknown,
  attemptNumber: number,
  maxAttempts: number = MAX_NOT_SENT_RETRY_ATTEMPTS,
): SubmitAttemptOutcome {
  if (error instanceof SubmitAssumedFilledError) {
    return {
      kind: "terminal-fail",
      reason: `assumed filled, never retried: ${error.message}`,
    };
  }
  if (error instanceof SubmitNotSentError) {
    if (attemptNumber < maxAttempts) {
      return { kind: "retry", reason: error.message };
    }
    return {
      kind: "terminal-fail",
      reason: `not-sent retry budget exhausted after ${maxAttempts} attempts: ${error.message}`,
    };
  }
  return {
    kind: "terminal-fail",
    reason: `unexpected delivery error, treated as assumed-filled: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}
