/**
 * The single, explicitly-read control gating all Regent-fencing dismiss
 * action. Defaults OFF: absent, empty, or any value other than `"1"` reads
 * as OFF. Mirrors `isAutoscaleKillSwitchOn`
 * (`src/alpha-autoscale/kill-switch.ts`) exactly, including its reason for
 * using an env var over `feature-flags.service.ts`: this module cannot
 * touch that shared surface from within its own declared footprint, and env
 * vars are the established convention for single binary switches read at
 * the call site.
 */
export const REGENT_FENCING_KILL_SWITCH_ENV_VAR = 'THRONE_REGENT_FENCING_ENABLED';

export function isRegentFencingKillSwitchOn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REGENT_FENCING_KILL_SWITCH_ENV_VAR] === '1';
}
