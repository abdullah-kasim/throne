import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlanUsagePlatformService } from "../plan-usage-remaining/plan-usage-platform.service.ts";
import { realPlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import type { HttpJsonRequest } from "../plan-usage-remaining/pipeline.types.ts";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import type { AccountPlaces } from "./account-places.ts";

export const NOW = new Date("2026-10-16T12:00:00Z");
export const COMPANY_DOMAIN = "company.example";
export const PERSONAL_DOMAIN = "personal.example";
export const PRIMARY_ACCESS_TOKEN = "access-token-of-the-primary-folder";
export const SECONDARY_ACCESS_TOKEN = "access-token-of-the-secondary-folder";

export function credentialsText(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "refresh-token",
      expiresAt: NOW.getTime() + 3_600_000,
      scopes: ["user:inference"],
    },
  });
}

export function usageEndpoint() {
  const requests: HttpJsonRequest[] = [];
  const utilizationByToken: Record<string, [number, number]> = {
    [`Bearer ${PRIMARY_ACCESS_TOKEN}`]: [30, 40],
    [`Bearer ${SECONDARY_ACCESS_TOKEN}`]: [55, 91],
  };
  const httpJson = async (request: HttpJsonRequest) => {
    requests.push(request);
    const [session, weekly] = utilizationByToken[request.headers.Authorization ?? ""] ?? [0, 0];
    return {
      status: 200,
      json: {
        five_hour: { utilization: session, resets_at: "2026-10-16T15:00:00Z" },
        seven_day: { utilization: weekly, resets_at: "2026-10-20T00:00:00Z" },
      },
    };
  };
  return { requests, httpJson };
}

export function primaryUsageService(httpJson: (request: HttpJsonRequest) => Promise<{ status: number; json: unknown }>) {
  return realPlanUsageRemainingService(
    new PlanUsagePlatformService({
      readCredentialsFile: async () => credentialsText(PRIMARY_ACCESS_TOKEN),
      httpJson,
      now: () => NOW,
      out: () => undefined,
      errOut: () => undefined,
    }),
  );
}

export function primaryUsageReader() {
  const service = primaryUsageService(usageEndpoint().httpJson);
  return () => service.getUsagePayload();
}

export interface AccountHomes {
  readonly places: AccountPlaces;
  readonly primaryFolder: string;
  readonly secondaryFolder: string;
  readonly settingsTarget: string;
}

export interface AccountHomesOptions {
  readonly primaryDomain?: string;
  readonly secondaryLoggedIn?: boolean;
  readonly writeAccountsFile?: boolean;
  readonly longRunningAccount?: string;
}

export async function makeAccountHomes(options: AccountHomesOptions = {}): Promise<AccountHomes> {
  const userHome = await makeScratchDirectory("account-homes-");
  process.env.THRONE_DATA_HOME = path.join(userHome, "throne-home");
  const primaryFolder = path.join(userHome, ".claude");
  const accountsFolder = path.join(userHome, "throne-home", "accounts", "claude");
  const secondaryFolder = path.join(accountsFolder, "secondary");
  const settingsFile = path.join(userHome, "dotfiles", "settings.json");
  await mkdir(path.join(primaryFolder, "skills"), { recursive: true });
  await mkdir(path.join(primaryFolder, "hooks"));
  await writeFile(path.join(primaryFolder, "CLAUDE.md"), "instructions\n");
  await mkdir(path.dirname(settingsFile));
  await writeFile(settingsFile, "{}\n");
  const settingsTarget = await realpath(settingsFile);
  await symlink(settingsTarget, path.join(primaryFolder, "settings.json"));
  await writeFile(
    path.join(userHome, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: `someone@${options.primaryDomain ?? COMPANY_DOMAIN}`, organizationUuid: "company-organisation" },
      mcpServers: { "company-chat": { command: "company" }, "company-tracker": { command: "company" }, "local-notes": { command: "local" } },
      migrationVersion: 14,
      opus45MigrationComplete: true,
      projects: { "/somewhere": { hasTrustDialogAccepted: true } },
    }),
  );
  await mkdir(secondaryFolder, { recursive: true });
  await writeFile(
    path.join(secondaryFolder, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: `someone@${PERSONAL_DOMAIN}`, organizationUuid: "personal-organisation" } }),
  );
  if (options.secondaryLoggedIn ?? true) {
    await writeFile(path.join(secondaryFolder, ".credentials.json"), credentialsText(SECONDARY_ACCESS_TOKEN));
  }
  const configPath = path.join(userHome, "throne-home", "config", "accounts.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  if (options.writeAccountsFile ?? true) {
    await writeFile(
      configPath,
      JSON.stringify({
        accounts: [
          { name: "primary", harness: "claude", folder: primaryFolder },
          { name: "secondary", harness: "claude", folder: secondaryFolder },
        ],
        ...(options.longRunningAccount === undefined ? {} : { longRunningAccount: options.longRunningAccount }),
        companyLogin: { emailDomain: COMPANY_DOMAIN },
        mcpServersAllowedOnEveryAccount: ["local-notes"],
      }),
    );
  }
  const repositoryStandInPath = path.join(userHome, "repository-stand-in");
  await writeFile(repositoryStandInPath, "#!/bin/bash\nexit 44\n");
  return {
    places: { configPath, userHome, accountsFolder, repositoryStandInPath },
    primaryFolder,
    secondaryFolder,
    settingsTarget,
  };
}

export async function linkSharedItemsInto(folder: string, homes: AccountHomes): Promise<void> {
  for (const name of ["CLAUDE.md", "skills", "hooks"]) {
    await symlink(path.join(homes.primaryFolder, name), path.join(folder, name));
  }
  await symlink(homes.settingsTarget, path.join(folder, "settings.json"));
}
