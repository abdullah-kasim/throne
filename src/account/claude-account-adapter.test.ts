import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import type { HttpJsonRequest } from "../plan-usage-remaining/pipeline.types.ts";
import { readAccountReading } from "./account-adapters.ts";
import { parseAccountsConfig, type Account } from "./accounts-config.ts";
import { readClaudeAccountLogin, readClaudeAccountUsage } from "./claude-account-adapter.ts";

const FOLDER_ACCESS_TOKEN = "access-token-of-the-secondary-folder";

async function secondaryFolder(options: { loggedIn: boolean; emailAddress?: string }) {
  const userHome = await makeScratchDirectory("claude-account-adapter-");
  const folder = path.join(userHome, "accounts", "secondary");
  await mkdir(folder, { recursive: true });
  await mkdir(path.join(userHome, ".claude"));
  await writeFile(
    path.join(userHome, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "someone@primary.example", organizationUuid: "primary-org" } }),
  );
  if (options.emailAddress !== undefined) {
    await writeFile(
      path.join(folder, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: options.emailAddress, organizationUuid: "secondary-org" } }),
    );
  }
  if (options.loggedIn) {
    await writeFile(
      path.join(folder, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: FOLDER_ACCESS_TOKEN,
          refreshToken: "refresh-token-of-the-secondary-folder",
          expiresAt: Date.now() + 3_600_000,
          scopes: ["user:inference"],
        },
      }),
    );
  }
  const account: Account = { name: "secondary", harness: "claude", folder };
  const config = parseAccountsConfig(
    JSON.stringify({
      accounts: [
        { name: "primary", harness: "claude", folder: path.join(userHome, ".claude") },
        { name: "secondary", harness: "claude", folder },
      ],
      companyLogin: { emailDomain: "company.example" },
    }),
    "accounts.json",
  );
  return { userHome, account, config };
}

function recordingUsageEndpoint() {
  const requests: HttpJsonRequest[] = [];
  const httpJson = async (request: HttpJsonRequest) => {
    requests.push(request);
    return {
      status: 200,
      json: {
        five_hour: { utilization: 42, resets_at: "2026-10-16T15:00:00Z" },
        seven_day: { utilization: 91, resets_at: "2026-10-20T00:00:00Z" },
      },
    };
  };
  return { requests, httpJson };
}

test("a folder's usage is read from that folder's own login", async () => {
  const { userHome, account } = await secondaryFolder({ loggedIn: true, emailAddress: "me@personal.example" });
  const { requests, httpJson } = recordingUsageEndpoint();
  const payload = await readClaudeAccountUsage(account, { userHome, httpJson });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.Authorization, `Bearer ${FOLDER_ACCESS_TOKEN}`);
  assert.equal(payload.source, "api");
  assert.deepEqual(
    payload.windows?.map((window) => [window.cap_window, window.used_pct]),
    [["5h", 42], ["weekly", 91]],
  );
});

test("a logged-out folder's usage is never read from another login", async () => {
  const { userHome, account } = await secondaryFolder({ loggedIn: false, emailAddress: "me@personal.example" });
  const { requests, httpJson } = recordingUsageEndpoint();
  const payload = await readClaudeAccountUsage(account, { userHome, httpJson });
  assert.equal(payload.source, "error");
  assert.equal(requests.length, 0);
});

test("a folder's login identity is its own email domain and organisation, and the company login is recognised from it", async () => {
  const personal = await secondaryFolder({ loggedIn: true, emailAddress: "me@Personal.example" });
  const company = await secondaryFolder({ loggedIn: true, emailAddress: "me@company.example" });
  const companyLogin = { emailDomain: "company.example" };
  assert.deepEqual(await readClaudeAccountLogin(personal.account, companyLogin, { userHome: personal.userHome }), {
    loggedIn: true,
    emailDomain: "personal.example",
    organizationUuid: "secondary-org",
    isCompany: false,
  });
  assert.equal((await readClaudeAccountLogin(company.account, companyLogin, { userHome: company.userHome })).isCompany, true);
});

test("a folder without its own credentials is not logged in and gets no usage reading", async () => {
  const { userHome, account, config } = await secondaryFolder({ loggedIn: false, emailAddress: "me@company.example" });
  const { requests, httpJson } = recordingUsageEndpoint();
  const reading = await readAccountReading(account, config, { userHome, httpJson });
  assert.deepEqual(reading, {
    name: "secondary",
    loggedIn: false,
    isCompany: false,
    loginDescription: "company.example",
    usage: { ok: false },
  });
  assert.equal(requests.length, 0);
});

test("a logged-in folder's reading carries its all-models windows for the balancer", async () => {
  const { userHome, account, config } = await secondaryFolder({ loggedIn: true, emailAddress: "me@personal.example" });
  const { httpJson } = recordingUsageEndpoint();
  const reading = await readAccountReading(account, config, { userHome, httpJson });
  assert.equal(reading.loggedIn, true);
  assert.equal(reading.usage.sessionPct, 58);
  assert.equal(reading.usage.weeklyPct, 9);
});
