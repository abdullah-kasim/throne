import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import { launchScriptText, translatedLaunchContext } from "../herdr/herdr-launch-command.ts";
import type { AccountHome } from "./claude-launch-environment.ts";

const runFile = promisify(execFile);

const PINNED_BINARY_ENVIRONMENT = { CLAUDE_BIN: "/pinned/vendor/claude" };
const TODAYS_RUNTIME_SETTINGS = '{"switchModelsOnFlag":false}';
const COMPANY_EMAIL_DOMAIN = "company.example";
const SECONDARY_ACCESS_TOKEN = "secondary-access-token-value";
const SECONDARY_REFRESH_TOKEN = "secondary-refresh-token-value";
const COMPANY_SERVER_SECRET = "company-server-bearer-value";

interface ScratchAccounts {
  readonly home: AccountHome;
  readonly secondaryFolder: string;
  readonly standInFolder: string;
  readonly fakeLauncher: string;
}

interface ScratchAccountsOptions {
  readonly withAccountsFile?: boolean;
  readonly withStandIn?: boolean;
  readonly serversAllowedOnEveryAccount?: readonly string[];
}

async function writeExecutable(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
  await chmod(filePath, 0o755);
}

async function scratchAccounts(options: ScratchAccountsOptions = {}): Promise<ScratchAccounts> {
  const userHome = await realpath(await makeScratchDirectory("claude-launch-environment-"));
  const throneHome = path.join(userHome, ".throne");
  const claudeAccounts = path.join(throneHome, "accounts", "claude");
  const secondaryFolder = path.join(claudeAccounts, "secondary");
  const standInFolder = path.join(claudeAccounts, "bin");
  await mkdir(path.join(userHome, ".claude"), { recursive: true });
  await mkdir(secondaryFolder, { recursive: true });
  await writeFile(
    path.join(userHome, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: `lord@${COMPANY_EMAIL_DOMAIN}`, organizationUuid: "company-org" },
      mcpServers: {
        "company-server": { type: "http", url: "https://company.example/mcp", headers: { Authorization: `Bearer ${COMPANY_SERVER_SECRET}` } },
        "company-tracker": { type: "http", url: "https://tracker.example/mcp" },
        playwright: { type: "stdio", command: "playwright-mcp" },
      },
    }),
  );
  await writeFile(
    path.join(secondaryFolder, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "lord@personal.example", organizationUuid: "personal-org" } }),
  );
  await writeFile(
    path.join(secondaryFolder, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: SECONDARY_ACCESS_TOKEN, refreshToken: SECONDARY_REFRESH_TOKEN } }),
    { mode: 0o600 },
  );
  if (options.withStandIn ?? true) {
    await writeExecutable(path.join(standInFolder, "security"), "#!/usr/bin/env bash\nexit 44\n");
  }
  if (options.withAccountsFile ?? true) {
    await mkdir(path.join(throneHome, "config"), { recursive: true });
    await writeFile(
      path.join(throneHome, "config", "accounts.json"),
      JSON.stringify({
        accounts: [
          { name: "primary", harness: "claude", folder: path.join(userHome, ".claude") },
          { name: "secondary", harness: "claude", folder: secondaryFolder },
        ],
        companyLogin: { emailDomain: COMPANY_EMAIL_DOMAIN },
        mcpServersAllowedOnEveryAccount: options.serversAllowedOnEveryAccount ?? ["playwright"],
      }),
    );
  }
  const fakeLauncher = path.join(userHome, "launcher", "claudey");
  await writeExecutable(
    fakeLauncher,
    '#!/usr/bin/env bash\nprintf "PATH=%s\\n" "$PATH"\nprintf "TOKEN=%s\\n" "${CLAUDE_CODE_OAUTH_TOKEN-unset}"\nprintf "CONFIG=%s\\n" "${CLAUDE_CONFIG_DIR-unset}"\n',
  );
  return { home: { environment: {}, userHome }, secondaryFolder, standInFolder, fakeLauncher };
}

function launchOn(accounts: ScratchAccounts, account: string | undefined, cwd?: string) {
  return translatedLaunchContext(
    {
      argv: ["claudey", "--model", "opus"],
      ...(account !== undefined ? { account } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    },
    PINNED_BINARY_ENVIRONMENT,
    accounts.home,
  );
}

function mcpConfigFileOf(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--mcp-config");
  assert.notEqual(flagIndex, -1, "the launch names an MCP config file");
  return argv[flagIndex + 1]!;
}

async function serverNamesIn(mcpConfigFile: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(mcpConfigFile, "utf8")) as { mcpServers: Record<string, unknown> };
  return Object.keys(parsed.mcpServers).sort();
}

test("without an accounts file a Claude launch is exactly today's", async () => {
  const accounts = await scratchAccounts({ withAccountsFile: false });
  const todays = { argv: ["claudey", "--model", "opus", "--settings", TODAYS_RUNTIME_SETTINGS], env: PINNED_BINARY_ENVIRONMENT };

  const withAccountName = await launchOn(accounts, "secondary");
  const withoutAccountName = await launchOn(accounts, undefined);

  assert.deepEqual(withAccountName, todays);
  assert.deepEqual(withoutAccountName, todays);
  assert.equal(launchScriptText(withAccountName, []), launchScriptText(todays, []));
});

test("a launch on the secondary sets its folder, the security stand-in and no token variables", async () => {
  const accounts = await scratchAccounts();

  const launch = await launchOn(accounts, "secondary");

  assert.deepEqual(launch.env, {
    ...PINNED_BINARY_ENVIRONMENT,
    CLAUDE_CONFIG_DIR: accounts.secondaryFolder,
    DISABLE_AUTOUPDATER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  });
  assert.deepEqual(launch.argv.slice(-3, -2), ["--mcp-config"]);
  assert.equal(launch.argv.at(-1), "--strict-mcp-config");
  const script = launchScriptText({ ...launch, argv: [accounts.fakeLauncher, ...launch.argv.slice(1)] }, []);
  const scriptPath = path.join(accounts.home.userHome, "launch");
  await writeExecutable(scriptPath, script);
  const { stdout } = await runFile("bash", [scriptPath], {
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "inherited-token-value" },
  });
  assert.match(stdout, new RegExp(`^PATH=${accounts.standInFolder}:`, "m"));
  assert.match(stdout, /^TOKEN=unset$/m);
  assert.match(stdout, new RegExp(`^CONFIG=${accounts.secondaryFolder}$`, "m"));
});

test("a launch on the company login keeps its claude.ai connectors and still names its MCP servers file", async () => {
  const accounts = await scratchAccounts();

  const launch = await launchOn(accounts, "primary");

  assert.ok((await stat(mcpConfigFileOf(launch.argv))).isFile());
  assert.equal(launch.argv.includes("--strict-mcp-config"), false);
  assert.equal(launch.env?.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
});

test("a launch on another account folder without the security stand-in is refused naming the missing file", async () => {
  const accounts = await scratchAccounts({ withStandIn: false });

  await assert.rejects(launchOn(accounts, "secondary"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(path.join(accounts.standInFolder, "security")));
    return true;
  });
});

test("a launch on the primary adds no account environment", async () => {
  const accounts = await scratchAccounts();

  const launch = await launchOn(accounts, "primary");

  assert.deepEqual(launch.env, PINNED_BINARY_ENVIRONMENT);
  assert.deepEqual(launch.unsetVariables, []);
  assert.equal(launch.prependedPath, undefined);
  assert.equal(launchScriptText(launch, []).includes("unset "), false);
  assert.equal(launchScriptText(launch, []).includes("export PATH="), false);
});

test("an account that is not in the accounts file is refused naming the configured accounts", async () => {
  const accounts = await scratchAccounts();

  await assert.rejects(launchOn(accounts, "tertiary"), /configured: primary, secondary/);
});

test("no credential value reaches the launch argv or environment", async () => {
  const accounts = await scratchAccounts();

  for (const account of ["primary", "secondary"]) {
    const launch = await launchOn(accounts, account);
    const visible = `${JSON.stringify(launch)}\n${launchScriptText(launch, [])}`;
    for (const credential of [SECONDARY_ACCESS_TOKEN, SECONDARY_REFRESH_TOKEN, COMPANY_SERVER_SECRET]) {
      assert.equal(visible.includes(credential), false, `${account} launch shows a credential`);
    }
    assert.equal((await stat(mcpConfigFileOf(launch.argv))).mode & 0o777, 0o600);
  }
});

test("the company account's agents get every MCP server and other accounts get only the servers allowed everywhere", async () => {
  const accounts = await scratchAccounts();

  const companyLaunch = await launchOn(accounts, "primary");
  const personalLaunch = await launchOn(accounts, "secondary");

  assert.deepEqual(await serverNamesIn(mcpConfigFileOf(companyLaunch.argv)), ["company-server", "company-tracker", "playwright"]);
  assert.equal(companyLaunch.env?.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  assert.deepEqual(await serverNamesIn(mcpConfigFileOf(personalLaunch.argv)), ["playwright"]);
  assert.equal(personalLaunch.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("an MCP server nobody marked counts as company-only", async () => {
  const accounts = await scratchAccounts({ serversAllowedOnEveryAccount: [] });

  const personalLaunch = await launchOn(accounts, "secondary");

  assert.deepEqual(await serverNamesIn(mcpConfigFileOf(personalLaunch.argv)), []);
});

test("worktree trust for a secondary agent is written into the secondary folder's own config", async () => {
  const accounts = await scratchAccounts();
  const worktree = await realpath(await makeScratchDirectory("claude-launch-worktree-"));

  await launchOn(accounts, "secondary", worktree);

  const secondaryConfig = JSON.parse(await readFile(path.join(accounts.secondaryFolder, ".claude.json"), "utf8"));
  const primaryConfig = JSON.parse(await readFile(path.join(accounts.home.userHome, ".claude.json"), "utf8"));
  assert.equal(secondaryConfig.projects[worktree].hasTrustDialogAccepted, true);
  assert.equal(secondaryConfig.hasSeenAutoDefaultNudge, true);
  assert.equal(secondaryConfig.oauthAccount.emailAddress, "lord@personal.example");
  assert.equal(primaryConfig.projects, undefined);
});
