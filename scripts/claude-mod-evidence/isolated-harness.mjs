import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchHerdrSuiteSession } from "../herdr-suite-session.mjs";
import { ownedHerdrClientPath } from "../../src/herdr/herdr-client.ts";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCRATCH_REPO_FIXTURE = path.join(repositoryRoot, "test", "fixtures", "claude-mod-evidence", "scratch-repo");
const AGENT_READY_LIMIT_MS = 60_000;
const LAUNCH_QUESTIONS = ["trust this folder", "Yes, I accept"];
const COMPOSER_PROMPT = "❯";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const SCRATCH_IDENTITY = { name: "Evidence Run", email: "evidence-run@example.com" };
const PERSONS_GIT_IDENTITY = /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG_|GIT_SIGNING_KEY$|THRONE_GIT_)/u;

function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function scratchEnvironment(environment) {
  const kept = Object.entries(environment).filter(([name]) => !PERSONS_GIT_IDENTITY.test(name));
  return { ...Object.fromEntries(kept), THRONE_LIVE_ROOT: repositoryRoot };
}

async function createScratchRepository(folder, environment) {
  await cp(SCRATCH_REPO_FIXTURE, folder, { recursive: true });
  for (const command of [
    ["init", "-q"],
    ["config", "user.name", SCRATCH_IDENTITY.name],
    ["config", "user.email", SCRATCH_IDENTITY.email],
    ["config", "commit.gpgsign", "false"],
    ["add", "."],
    ["commit", "-qm", "fixture"],
  ]) {
    await run("git", command, { cwd: folder, env: environment });
  }
}

export const CONFIG_LEFT_OUT = ["projects", "history.jsonl", "paste-cache", "shell-snapshots", "session-env", "file-history", ".claude_repo_backups"];

function vanished(error) {
  return error?.code === "ENOENT";
}

async function copyTree(source, target, skipped) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source).catch((error) => (vanished(error) ? [] : Promise.reject(error)));
  for (const entry of entries) {
    if (skipped(entry) || entry.endsWith(".lock")) continue;
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    const found = await stat(from).catch((error) => (vanished(error) ? undefined : Promise.reject(error)));
    if (found?.isDirectory()) await copyTree(from, to, () => false);
    else if (found) await copyFile(from, to).catch((error) => (vanished(error) ? undefined : Promise.reject(error)));
  }
}

export async function copyClaudeConfig(source, target) {
  await copyTree(source, target, (entry) => CONFIG_LEFT_OUT.includes(entry));
}

async function scratchHome(root, repo, claudeConfig) {
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".local", "share", "mise"), { recursive: true });
  await symlink(path.join(os.homedir(), ".local", "share", "mise", "installs"), path.join(home, ".local", "share", "mise", "installs"));
  const person = JSON.parse(await readFile(path.join(os.homedir(), ".claude.json"), "utf8"));
  const trusted = JSON.stringify({ ...person, projects: Object.fromEntries([repo, root, repositoryRoot, process.env.THRONE_LIVE_ROOT].filter(Boolean).map((folder) => [folder, { hasTrustDialogAccepted: true }])) });
  await writeFile(path.join(home, ".claude.json"), trusted);
  await symlink(claudeConfig, path.join(home, ".claude"));
  await symlink(path.join(os.homedir(), "dotfiles"), path.join(home, "dotfiles"));
  await writeFile(path.join(claudeConfig, ".claude.json"), trusted);
  return home;
}

export async function openIsolatedHarness({ line, evidenceFolder }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cme-"));
  const repo = path.join(root, "repo");
  const dataHome = path.join(root, "data");
  const configHome = path.join(root, "c");
  await Promise.all([mkdir(dataHome, { recursive: true }), mkdir(configHome, { recursive: true }), mkdir(evidenceFolder, { recursive: true })]);
  await createScratchRepository(repo, scratchEnvironment(process.env));
  const claudeConfig = path.join(root, "claude-config");
  await copyClaudeConfig(path.join(os.homedir(), ".claude"), claudeConfig);
  const home = await scratchHome(root, repo, claudeConfig);
  const port = await freePort();
  const environment = {
    ...scratchEnvironment(process.env),
    HOME: home,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    CLAUDE_CONFIG_DIR: claudeConfig,
    DISABLE_AUTOUPDATER: "1",
    XDG_CONFIG_HOME: configHome,
    THRONE_DATA_HOME: dataHome,
    THRONE_WEB_PORT: String(port),
  };
  const session = await launchHerdrSuiteSession(`cme-${line.replace(/\W/g, "")}-${path.basename(root).slice(4)}`, environment);
  environment.THRONE_HERDR_SESSION_NAME_OVERRIDE = session.sessionName;
  const herdrClient = ownedHerdrClientPath(environment);
  const claudeFolder = path.dirname((await run("bash", ["-c", "command -v claude"], { env: environment })).stdout.trim());
  const herdr = async (...argumentsList) =>
    (await run(herdrClient, ["--session", session.sessionName, ...argumentsList], { env: environment, cwd: repo, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const evidence = [];

  async function saveText(label, text) {
    const file = path.join(evidenceFolder, `${label}.txt`);
    await writeFile(file, text, "utf8");
    evidence.push(file);
    return file;
  }

  async function waitForComposer(name, pane) {
    const started = Date.now();
    for (;;) {
      const visible = await herdr("pane", "read", pane, "--source", "visible");
      if (LAUNCH_QUESTIONS.some((question) => visible.includes(question))) {
        await herdr("pane", "send-keys", pane, "down");
        await herdr("pane", "send-keys", pane, "enter");
        await sleep(3000);
      } else if (visible.includes(COMPOSER_PROMPT)) {
        break;
      }
      if (Date.now() - started > AGENT_READY_LIMIT_MS) {
        await saveText(`${name}-never-ready`, visible);
        throw new Error(`Claude Code in pane ${pane} never showed its composer`);
      }
      await sleep(500);
    }
  }

  async function startClaude({ name, claudeArguments = [], launchEnvironment = {} }) {
    const workspace = JSON.parse(await herdr("workspace", "create", "--label", name, "--cwd", repo));
    const pane = workspace.result.root_pane.pane_id;
    const exports = Object.entries(launchEnvironment).map(([key, value]) => ` && export ${key}=${shellWord(value)}`).join("");
    await herdr("pane", "run", pane, `cd ${repo} && export PATH="${claudeFolder}:$PATH"${exports}`);
    await herdr("agent", "start", name, "--kind", "claude", "--pane", pane, "--timeout", String(AGENT_READY_LIMIT_MS), "--", ...claudeArguments).catch(() => undefined);
    const screen = async () => herdr("pane", "read", pane, "--source", "visible");
    await waitForComposer(name, pane);
    return {
      name,
      pane,
      screen,
      saveScreen: async (label) => saveText(`${name}-${label}`, await screen()),
      putDraft: async (text) => herdr("pane", "send-text", pane, text),
      clearDraft: async () => herdr("pane", "send-keys", pane, "ctrl+u"),
      submitTyped: async (text) => {
        await herdr("pane", "send-text", pane, text);
        await sleep(300);
        await herdr("pane", "send-keys", pane, "enter");
      },
      holdTurn: async (seconds) => {
        await herdr("pane", "send-text", pane, `Run this exact command in the foreground and wait for it to finish: python3 hold-turn.py ${seconds} ; then reply with the single word held.`);
        await sleep(300);
        await herdr("pane", "send-keys", pane, "enter");
      },
    };
  }

  async function close() {
    await session.cleanup().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }

  return { root, repo, dataHome, home, claudeConfig, environment, port, sessionName: session.sessionName, herdrClient, herdr, evidence, saveText, startClaude, waitForComposer, close };
}
