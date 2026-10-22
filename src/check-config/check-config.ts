import {
  planRolePool,
  targetEffortForRole,
  activePlanPresetName,
  type EffortRole,
  type ModelPairPool,
  type PlanRole,
} from "../config.ts";
import os from "node:os";
import { accountAdapterFor } from "../account/account-adapters.ts";
import { accountsConfigPath, readAccountsConfig } from "../account/accounts-config.ts";
import { configuredRegentLaunch } from "../regent-state/regent-launch-recipe.ts";
import { resolveUserConfigPath } from "../user-config-loader.ts";
import { loadNtfyUserConfig } from "../application-config.service.ts";
import { notifyConfigFrom, ntfyServerAnswers } from "../notify-lord/notification.service.ts";

const NTFY_SETUP_DOC = "agent_docs/ntfy-phone-notifications.md";

const EFFORT_NAMES = ["", "low", "medium", "high", "xhigh", "max", "ultracode"];

const POOL_ROLES: readonly { planRole: PlanRole; effortRole: EffortRole }[] = [
  { planRole: "Alpha", effortRole: "alpha" },
  { planRole: "Shadow", effortRole: "shadow" },
  { planRole: "ShadowSlice99", effortRole: "shadowSlice99" },
  { planRole: "Stager", effortRole: "stager" },
];

function describePool(pool: ModelPairPool): string {
  return pool.map(({ harness, model }) => `${harness}/${model}`).join(", ");
}

function describeEffort(effort: number): string {
  return `${effort} (${EFFORT_NAMES[effort] ?? "unknown"} on claude)`;
}

export function renderResolvedSteering(configPath: string): string {
  const lines = [
    `check-config: ${configPath} loaded and validated.`,
    `plan preset: ${activePlanPresetName()}`,
  ];
  for (const { planRole, effortRole } of POOL_ROLES) {
    lines.push(
      `${planRole}: ${describePool(planRolePool(planRole))} at effort ${describeEffort(targetEffortForRole(effortRole))}`,
    );
  }
  const regent = configuredRegentLaunch();
  lines.push(
    regent === undefined
      ? "Regent: no regentRoute; launches as before (recorded route at effort 1, or bare claudey)"
      : `Regent: ${regent.harness}/${regent.model} at effort ${describeEffort(regent.effort)}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function renderAccountLines(
  configPath: string = accountsConfigPath(),
  userHome: string = os.homedir(),
): Promise<string> {
  const config = readAccountsConfig(configPath);
  if (config === null) return "";
  const lines = await Promise.all(
    config.accounts.map(async (account) => {
      const login = await accountAdapterFor(account).readLogin(account, config.companyLogin, { userHome });
      return `account ${account.name}: ${account.folder}, ${login.loggedIn ? "logged in" : "logged out"}\n`;
    }),
  );
  return lines.join("");
}

export interface NtfyReport {
  text: string;
  failed: boolean;
}

export async function renderNtfyLine(configPath: string): Promise<NtfyReport> {
  const ntfySection = await loadNtfyUserConfig(configPath);
  const notifyConfig = notifyConfigFrom(ntfySection);
  if (!notifyConfig.sendingEnabled) {
    return { text: "ntfy: phone notifications are off (ntfy.enabled is false), so the server is not checked\n", failed: false };
  }
  if (ntfySection === undefined) {
    return {
      text: `ntfy: FAILED, ${configPath} has no ntfy section; set one up as ${NTFY_SETUP_DOC} describes\n`,
      failed: true,
    };
  }
  if (await ntfyServerAnswers(notifyConfig.serverUrl, notifyConfig.timeoutMs)) {
    return { text: `ntfy: the server at ${notifyConfig.serverUrl} answered its health check\n`, failed: false };
  }
  return { text: `ntfy: FAILED, the server at ${notifyConfig.serverUrl} did not answer its health check\n`, failed: true };
}

export async function run(): Promise<number> {
  const configPath = await resolveUserConfigPath();
  process.stdout.write(renderResolvedSteering(configPath));
  process.stdout.write(await renderAccountLines());
  const ntfyReport = await renderNtfyLine(configPath);
  process.stdout.write(ntfyReport.text);
  return ntfyReport.failed ? 1 : 0;
}
