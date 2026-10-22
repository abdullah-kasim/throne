import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { readAccountReading } from "../account/account-adapters.ts";
import {
  credentialsText,
  makeAccountHomes,
  NOW,
  PRIMARY_ACCESS_TOKEN,
  usageEndpoint,
} from "../account/account-homes.test-support.ts";
import { readAccountsConfig } from "../account/accounts-config.ts";
import { chooseSpawnAccount, type AccountReading } from "../harness-routing/policy/account-balance.ts";
import { readHarnessUsage } from "../harness-routing/policy/usage.ts";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  keychainReaderAt,
  MACOS_SECURITY_PATH,
  readClaudeCredentialsRaw,
} from "./claude-credential-source.ts";
import { PlanUsagePlatformService } from "./plan-usage-platform.service.ts";
import { realPlanUsageRemainingService } from "./plan-usage-remaining.service.ts";

const STAND_IN_EXIT_CODE = 44;
const pathBeforeTheTests = process.env.PATH;

async function writeExecutable(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
  await chmod(filePath, 0o755);
}

function realSecurityThatHoldsThePrimaryLogin(): string {
  return [
    "#!/bin/sh",
    `if [ "$*" = "find-generic-password -s ${CLAUDE_KEYCHAIN_SERVICE} -w" ]; then`,
    `  printf '%s\\n' '${credentialsText(PRIMARY_ACCESS_TOKEN)}'`,
    "  exit 0",
    "fi",
    "exit 1",
    "",
  ].join("\n");
}

let fakeRealSecurityPath = "";
let missingPrimaryCredentialsPath = "";

before(async () => {
  const scratch = await makeScratchDirectory("primary-keychain-past-stand-in-");
  const standInFolder = path.join(scratch, "accounts", "claude", "bin");
  fakeRealSecurityPath = path.join(scratch, "usr", "bin", "security");
  missingPrimaryCredentialsPath = path.join(scratch, ".claude", ".credentials.json");
  await writeExecutable(path.join(standInFolder, "security"), `#!/bin/sh\nexit ${STAND_IN_EXIT_CODE}\n`);
  await writeExecutable(fakeRealSecurityPath, realSecurityThatHoldsThePrimaryLogin());
  process.env.PATH = `${standInFolder}${path.delimiter}${pathBeforeTheTests ?? ""}`;
});

after(() => {
  process.env.PATH = pathBeforeTheTests;
});

async function readPrimaryReadingThroughTheKeychain(httpJson: ReturnType<typeof usageEndpoint>["httpJson"]): Promise<AccountReading> {
  const platform = new PlanUsagePlatformService({
    readCredentialsFile: () =>
      readClaudeCredentialsRaw(missingPrimaryCredentialsPath, {
        readFile: (filePath) => readFile(filePath, "utf8"),
        readKeychainItem: keychainReaderAt(fakeRealSecurityPath),
        platform: "darwin",
      }),
    httpJson,
    now: () => NOW,
    out: () => undefined,
    errOut: () => undefined,
  });
  const usage = readHarnessUsage(await realPlanUsageRemainingService(platform).getUsagePayload());
  return { name: "primary", loggedIn: true, isCompany: true, loginDescription: "company.example", usage };
}

test("the primary is read and chosen while under 90% from a shell whose PATH has the security stand-in first", async () => {
  const homes = await makeAccountHomes();
  const config = readAccountsConfig(homes.places.configPath)!;
  const endpoint = usageEndpoint();
  const primary = await readPrimaryReadingThroughTheKeychain(endpoint.httpJson);
  const secondary = await readAccountReading(config.accounts[1]!, config, {
    userHome: homes.places.userHome,
    httpJson: endpoint.httpJson,
  });

  const choice = chooseSpawnAccount({ role: "shadow", config, readings: [primary, secondary] });

  assert.equal(primary.usage.ok, true);
  assert.equal(choice.kind, "account");
  assert.equal(choice.kind === "account" ? choice.name : undefined, "primary");
});

test("the throne reads the Keychain through the macOS security at its absolute path", () => {
  assert.equal(MACOS_SECURITY_PATH, "/usr/bin/security");
});
