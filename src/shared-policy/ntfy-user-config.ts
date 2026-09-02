// The one non-display section the live `config.user.ts` carries. It is here,
// in the gitignored user file rather than the committed tree, because both of
// its fields are host-local secrets: the server URL is a private tailnet
// address, and the topic is an unguessable string anyone holding it can push
// to the Lord's phone with. `src/notify-lord/notification.service.ts` keeps
// inert loopback defaults for a fresh clone.

import { describeValue, isPlainObject } from './config-value-shape.ts';

export interface NtfyUserConfig {
  /** Base URL of the ntfy server, e.g. `http://100.64.0.1:8410`. */
  readonly serverUrl?: string;
  /** The topic to publish to. Treat it as a shared secret. */
  readonly topic?: string;
}

export const NTFY_FIELDS = ['serverUrl', 'topic'] as const;

/**
 * Validates a user file's `ntfy` section. `invalid` and `requireNonEmptyString`
 * are supplied by the caller so this section rejects in exactly the same error
 * vocabulary as every other field of the same file — one message shape, one
 * dot-path convention.
 */
export function validateNtfy(
  value: unknown,
  invalid: (field: string, expectation: string) => Error,
  requireNonEmptyString: (value: unknown, field: string) => string,
): NtfyUserConfig {
  if (!isPlainObject(value)) {
    throw invalid(
      'ntfy',
      `must be a plain object of ntfy settings (got ${describeValue(value)})`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!(NTFY_FIELDS as readonly string[]).includes(key)) {
      throw invalid(
        `ntfy.${key}`,
        `is not a known field (expected one of: ${NTFY_FIELDS.join(', ')})`,
      );
    }
  }
  const ntfy: { -readonly [K in keyof NtfyUserConfig]?: string } = {};
  for (const field of NTFY_FIELDS) {
    if (field in value) {
      ntfy[field] = requireNonEmptyString(value[field], `ntfy.${field}`);
    }
  }
  return ntfy;
}
