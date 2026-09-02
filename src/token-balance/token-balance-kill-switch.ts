/**
 * The single, explicitly-read control gating all token-lane-balance
 * behavior (create-agent's off-lane refusal and alpha-autoscale's lane
 * consult). Defaults OFF: absent, empty, or any value other than `"1"`
 * reads as OFF, reproducing today's unbalanced dispatch exactly. Mirrors
 * `src/alpha-autoscale/kill-switch.ts`'s single-env-var pattern.
 */
export const TOKEN_BALANCE_KILL_SWITCH_ENV_VAR = 'THRONE_TOKEN_BALANCE_ENABLED';

export function isTokenBalanceKillSwitchOn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[TOKEN_BALANCE_KILL_SWITCH_ENV_VAR] === '1';
}
