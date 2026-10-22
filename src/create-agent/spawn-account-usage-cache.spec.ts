import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Account, AccountsConfig } from "../account/accounts-config.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import type { CreateAgentDeps, RegistrationResolution } from "./create.types.ts";
import { resolveSpawnAccount } from "./spawn-account.ts";

const USAGE_ENDPOINT_PATH = "/api/oauth/usage";

let scratchRoot: string;
let realFetch: typeof fetch;
const usageRequestsByToken = new Map<string, number>();

before(async () => {
  scratchRoot = await makeScratchDirectory("spawn-account-usage-cache-");
  process.env.THRONE_DATA_HOME = path.join(scratchRoot, "throne-home");
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).endsWith(USAGE_ENDPOINT_PATH), `only the usage endpoint may be asked, not ${String(input)}`);
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    usageRequestsByToken.set(authorization, (usageRequestsByToken.get(authorization) ?? 0) + 1);
    return Response.json({
      five_hour: { utilization: 10, resets_at: "2026-10-16T15:00:00Z" },
      seven_day: { utilization: 30, resets_at: "2026-10-20T00:00:00Z" },
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

async function loggedInAccount(name: string): Promise<Account> {
  const folder = path.join(scratchRoot, "accounts", name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: `${name}@personal.example` } }));
  await writeFile(
    path.join(folder, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `access-token-of-${name}`,
        refreshToken: `refresh-token-of-${name}`,
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
      },
    }),
  );
  return { name, harness: "claude", folder };
}

function spawnRequest(index: number): RegistrationResolution {
  return {
    name: `shadow-cache-${index}`,
    role: "Shadow",
    flags: {},
    launchHarness: HARNESS_NAMES.CLAUDE,
    resuming: false,
  } as unknown as RegistrationResolution;
}

test("twenty spawns inside the fresh window make one usage request per account", async () => {
  const config: AccountsConfig = {
    accounts: [await loggedInAccount("first"), await loggedInAccount("second")],
    mcpServersAllowedOnEveryAccount: [],
  };
  const stderr: string[] = [];
  const deps = {
    readAccountsConfig: () => config,
    writeStderr: (text: string) => stderr.push(text),
  } as unknown as CreateAgentDeps;

  for (let index = 0; index < 20; index += 1) {
    const result = await resolveSpawnAccount(spawnRequest(index), undefined, deps);
    assert.equal(result.ok, true, stderr.join(""));
  }

  assert.deepEqual(Object.fromEntries(usageRequestsByToken), {
    "Bearer access-token-of-first": 1,
    "Bearer access-token-of-second": 1,
  });
});
