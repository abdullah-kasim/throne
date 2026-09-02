/** Explicit enable switch for the destructive autoreap actor; absent is safely off. */
export const AUTOREAP_ENABLED_ENV_VAR = 'THRONE_AUTOREAP_ENABLED';

export function isAutoreapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTOREAP_ENABLED_ENV_VAR] === '1';
}
