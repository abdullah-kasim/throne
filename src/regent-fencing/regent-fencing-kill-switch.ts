/**
 * The single, explicitly-read control gating all Regent-fencing dismiss
 * action. Defaults OFF: absent, empty, or any value other than `"1"` reads
 * as OFF. Mirrors `isAutoscaleKillSwitchOn`
 * (`src/alpha-autoscale/kill-switch.ts`) exactly.
 */
export const REGENT_FENCING_KILL_SWITCH_ENV_VAR = 'THRONE_REGENT_FENCING_ENABLED';

export function isRegentFencingKillSwitchOn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REGENT_FENCING_KILL_SWITCH_ENV_VAR] === '1';
}
