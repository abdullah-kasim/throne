import { HARNESS_NAMES, runtimeHarness } from '../harness-routing/harness.ts';
import { resolveTrustKey } from '../codex-trust/codex-trust.service.ts';
import {
  POST_SPAWN_RESOLVE_ATTEMPTS,
  POST_SPAWN_RESOLVE_POLL_MS,
  resolveSpawnedAgent,
} from './registration.ts';
import {
  type CreateAgentDeps,
  type PolicyResolution,
} from './create.types.ts';
import { stderrWriter } from './command-context.ts';

export async function prepareCodexLaunchTrust(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): Promise<boolean> {
  if (runtimeHarness(request.launchHarness) !== HARNESS_NAMES.CODEX) {
    return true;
  }
  try {
    await deps.ensureCodexTrust(request.cwd);
    return true;
  } catch (error) {
    stderrWriter(deps)(
      `create-agent: refusing to spawn codex agent "${request.name}" — could not ` +
        `register codex folder trust for cwd "${request.cwd}" ` +
        `(${error instanceof Error ? error.message : String(error)}). Nothing was ` +
        `spawned; a codex launch into an untrusted directory would freeze at ` +
        `the trust prompt.\n`,
    );
    return false;
  }
}

export async function verifyCodexLaunchTrust(
  request: PolicyResolution,
  deps: CreateAgentDeps,
): Promise<boolean> {
  if (runtimeHarness(request.launchHarness) !== HARNESS_NAMES.CODEX) {
    return true;
  }
  const writeStderr = stderrWriter(deps);
  const agent = await resolveSpawnedAgent(request.name, deps);
  if (agent === undefined) {
    writeStderr(
      `create-agent: spawned "${request.name}" but herdr did not register it within ` +
        `${(POST_SPAWN_RESOLVE_ATTEMPTS - 1) * POST_SPAWN_RESOLVE_POLL_MS}ms. ` +
        `Registration is retained in data/${request.name}/ because its pane may be live. ` +
        `Wait for ./bin/throne-cli agent-statuses to show it LIVE, then inspect ` +
        `it with ./bin/throne-cli agent-logs ${request.name} --source visible or tear it ` +
        `down with ./bin/throne-cli reap-agent ${request.name} --force --reason force.\n`,
    );
    return false;
  }
  if (!(await deps.probeCodexTrustPrompt(agent.terminalId))) {
    return true;
  }
  try {
    await deps.closeAgentTab(agent);
  } catch (error) {
    writeStderr(
      `create-agent: codex "${request.name}" stopped at the folder-trust prompt, but ` +
        `its tab could not be torn down ` +
        `(${error instanceof Error ? error.message : String(error)}). Registration ` +
        `is retained in data/${request.name}/ because its pane may still be live; ` +
        `run ./bin/throne-cli reap-agent ${request.name} --force --reason force.\n`,
    );
    return false;
  }
  if (request.resuming) {
    writeStderr(
      `create-agent: codex "${request.name}" stopped at the folder-trust prompt and ` +
        `its tab was torn down. Its pre-existing registration was retained; ` +
        `run ./bin/throne-cli reap-agent ${request.name} --reason error to tear it down.\n`,
    );
    return false;
  }
  try {
    await deps.removeRegistration(request.name);
  } catch (error) {
    writeStderr(
      `create-agent: codex "${request.name}" stopped at the folder-trust prompt and ` +
        `its tab was torn down, but registration cleanup failed ` +
        `(${error instanceof Error ? error.message : String(error)}). The retained ` +
        `data/${request.name}/ record has no live pane; run ` +
        `./bin/throne-cli reap-agent ${request.name} --reason error.\n`,
    );
    return false;
  }
  const untrustedPath = resolveTrustKey(request.cwd);
  writeStderr(
    `create-agent: codex "${request.name}" stopped at the folder-trust prompt for ` +
      `"${untrustedPath}" and was aborted after registration — its herdr ` +
      `tab was torn down before the registration was removed, so no orphaned ` +
      `agent remains. Trust that exact path (add a ` +
      `[projects."${untrustedPath}"] table with trust_level = "trusted" to ` +
      `your codex config.toml) and retry.\n`,
  );
  return false;
}
