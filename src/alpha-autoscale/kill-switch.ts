/**
 * The single, explicitly-read control gating all autoscale spawn action.
 * Defaults OFF: absent, empty, or any value other than `"1"` reads as OFF.
 * An env var (not a feature-flags.json entry) because this module cannot
 * touch `feature-flags.service.ts` -- outside this slice's declared
 * `src/alpha-autoscale/` footprint -- and env vars are already the
 * established convention for other single binary switches read at the call
 * site (e.g. `THRONE_FULL_SUITE_LOCK_DIR`).
 */
export const AUTOSCALE_KILL_SWITCH_ENV_VAR = 'THRONE_ALPHA_AUTOSCALE_ENABLED';

export function isAutoscaleKillSwitchOn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[AUTOSCALE_KILL_SWITCH_ENV_VAR] === '1';
}
