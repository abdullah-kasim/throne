import { loadUserConfigFile } from '../user-config-loader.ts';

/**
 * The env-var half of the autoscale spawn gate. Since 2026-09-02 it reads ON
 * unless explicitly `"0"` (see `isAutoscaleKillSwitchOn`), and is ALSO set to
 * `1` by both service templates (`systemd/throne-backend.service`
 * `Environment=`, `launchd/com.throne.throne-backend.plist`
 * `EnvironmentVariables`) — the Lord's order after the live proof that it was
 * set nowhere and the worker had never spawned an Alpha on any host. The
 * operator's pause is the OTHER half, `readAutoscaleEnabledInUserConfig`
 * below; both must be on for a tick to act.
 * An env var (not a feature-flags.json entry) because this module cannot
 * touch `feature-flags.service.ts` -- outside this slice's declared
 * `src/alpha-autoscale/` footprint -- and env vars are already the
 * established convention for other single binary switches read at the call
 * site (e.g. `THRONE_FULL_SUITE_LOCK_DIR`).
 */
export const AUTOSCALE_KILL_SWITCH_ENV_VAR = 'THRONE_ALPHA_AUTOSCALE_ENABLED';

/**
 * ARMED UNLESS EXPLICITLY `"0"`. Until 2026-09-02 this read ON only for `"1"`,
 * which meant a manual `throne autoscale-now` from an operator's shell -- a
 * process that never inherits the service template's Environment= -- stopped
 * at "skip: kill switch off" while the cron tick in the backend proceeded.
 * The Lord watched exactly that happen during a demo. His standing order is
 * that the autoscaler is permanently armed; the operator pause is
 * `steering.autoscaleEnabled` in config.user.ts, read by
 * `readAutoscaleEnabledInUserConfig` below, and it applies identically to the
 * cron and to a shell. `"0"` remains the emergency env-level off.
 */
export function isAutoscaleKillSwitchOn(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[AUTOSCALE_KILL_SWITCH_ENV_VAR] !== '0';
}

/**
 * The config half of the gate: `steering.autoscaleEnabled` in the live
 * `config.user.ts`, READ FRESH ON EVERY CALL. The backend is a long-lived
 * process and Node's ESM loader caches a module for the life of that process,
 * so the module-level `RESOLVED_STEERING_CONFIG` would report whatever the
 * file said at backend start and the `/autoscaler off` skill would appear to
 * do nothing until a restart. The cache-bust token forces a re-parse per tick
 * (once per five minutes — the same trick `switch-persona` uses to verify its
 * own write).
 *
 * Fails CLOSED: an unreadable or invalid file pauses the autoscaler and says
 * why in the returned reason, rather than spawning on a config nobody can
 * read. An ABSENT file is ON — the Lord's armed-by-default ruling.
 */
let cacheBustSequence = 0;

export async function readAutoscaleEnabledInUserConfig(
  // Test/fixture seam only, mirroring `loadUserConfigFile`; production passes
  // nothing and resolves the live throne root.
  configPath?: string,
): Promise<
  { readonly enabled: true } | { readonly enabled: false; readonly reason: string }
> {
  let file;
  try {
    // Strictly unique per call: two reads inside the same millisecond share a
    // `Date.now()` token and the second is served from the ESM cache -- seen
    // as a flake in autoscale-config-pause.test.ts on 2026-09-02.
    file = await loadUserConfigFile(configPath, `${Date.now()}-${++cacheBustSequence}`);
  } catch (error) {
    return {
      enabled: false,
      reason: `config.user.ts could not be loaded, so the autoscaler is paused rather than spawning blind: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (file === undefined) return { enabled: true };
  const value = file.steering['autoscaleEnabled'];
  if (value === undefined || value === true) return { enabled: true };
  if (value === false) {
    return {
      enabled: false,
      reason: 'autoscaler disabled in config.user.ts (steering.autoscaleEnabled: false) -- the court is paused; set it true or remove it to resume (the /autoscaler skill does this)',
    };
  }
  return {
    enabled: false,
    reason: `config.user.ts steering.autoscaleEnabled must be a boolean (got ${typeof value}); paused until it is`,
  };
}
