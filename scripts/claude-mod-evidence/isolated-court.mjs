import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import { answered, startModAgent } from "./lines/m3-mod-agent.mjs";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const throneCli = path.join(repositoryRoot, "bin", "throne-cli");
const SENDER = "evidence-sender";
const BACKEND_READY_LIMIT_MS = 60_000;
export const GENERATED_REGENT_SKILL = path.join(repositoryRoot, ".claude", "skills", "herdr");
const COMMANDS_THAT_MUST_FAIL = ["systemctl", "tailscale", "codex", "claude"];

async function failingCommands(harness) {
  const folder = path.join(harness.root, "failing-commands");
  await mkdir(folder, { recursive: true });
  for (const name of COMMANDS_THAT_MUST_FAIL) {
    await writeFile(path.join(folder, name), "#!/bin/sh\nexit 1\n");
    await chmod(path.join(folder, name), 0o755);
  }
  return folder;
}

export async function startCourtModAgent(harness, name) {
  const agent = await startModAgent(harness, name);
  await agent.submitTyped("Reply with only the word primed.");
  if (!(await answered(agent, "primed"))) throw new Error(`${name} never answered its first typed turn`);
  await recordModAgent(harness, agent);
  return agent;
}

export async function recordModAgent(harness, agent) {
  const folder = path.join(harness.dataHome, "data", agent.name);
  await mkdir(folder, { recursive: true });
  const spawned = new Date().toISOString();
  const spec = { harness: "claude", model: "haiku", effort: 1, cwd: harness.repo, spawned_at: spawned, spawn_finished_at: spawned, claude_mod: true, delivery_socket: agent.socket };
  await writeFile(path.join(folder, "spawn.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

async function writeEmptyUserConfig(dataHome) {
  const folder = path.join(dataHome, "config");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(folder, "config.user.ts"), "export default {};\n");
}

export function keepFolderAsFound(folder) {
  const present = existsSync(folder);
  return async () => {
    if (!present) await rm(folder, { recursive: true, force: true });
  };
}

export async function openIsolatedCourt(harness, { herdrClientPath = harness.herdrClient } = {}) {
  const restoreRegentSkill = keepFolderAsFound(GENERATED_REGENT_SKILL);
  await writeEmptyUserConfig(harness.dataHome);
  const sender = await harness.startClaude({ name: SENDER, claudeArguments: ["--setting-sources", "local", "--model", "haiku"] });
  const environment = {
    ...harness.environment,
    PATH: `${await failingCommands(harness)}:${harness.environment.PATH}`,
    THRONE_LIVE_ROOT: repositoryRoot,
    THRONE_RECIPIENT_LOCK_DIR: path.join(harness.root, "recipient-locks"),
    THRONE_NTFY_SERVER_URL: "http://127.0.0.1:9",
    THRONE_HERDR_CLIENT_PATH: herdrClientPath,
  };
  const senderEnvironment = { ...environment, THRONE_AGENT_NAME: SENDER, HERDR_PANE_ID: sender.pane };
  const backendLog = path.join(harness.root, "backend.log");
  let backend;
  let starts = 0;

  async function startBackend() {
    starts += 1;
    const log = createWriteStream(backendLog, { flags: "a" });
    backend = spawn(throneCli, ["throne-backend"], { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    backend.stdout.pipe(log);
    backend.stderr.pipe(log);
    const started = Date.now();
    for (;;) {
      const listening = await fetch(`http://127.0.0.1:${harness.port}/`).then(() => true, () => false);
      if (listening) return;
      if (Date.now() - started > BACKEND_READY_LIMIT_MS) throw new Error(`the isolated throne-backend never answered on port ${harness.port}`);
      await sleep(500);
    }
  }

  async function killBackend() {
    if (!backend || backend.exitCode !== null) return;
    const exited = new Promise((resolve) => backend.once("exit", resolve));
    process.kill(-backend.pid, "SIGKILL");
    await exited;
  }

  async function sendAgent(recipient, text) {
    const { stdout } = await run(throneCli, ["send-agent", recipient, text], { env: senderEnvironment });
    const id = stdout.match(/queued as message (\d+)/u)?.[1];
    if (!id) throw new Error(`send-agent queued nothing: ${stdout}`);
    return id;
  }

  async function messageStatus(id) {
    const { stdout } = await run(throneCli, ["message-status", id], { env: environment });
    return stdout.trim();
  }

  async function waitForStatus(id, wanted, limitMs) {
    const started = Date.now();
    for (;;) {
      const status = await messageStatus(id);
      if (status === wanted || Date.now() - started > limitMs) return status;
      await sleep(1000);
    }
  }

  async function throne(argumentsList, { root = repositoryRoot, limitMs = 300_000 } = {}) {
    const result = await run(path.join(root, "bin", "throne-cli"), argumentsList, { env: senderEnvironment, cwd: root, timeout: limitMs, maxBuffer: 16 * 1024 * 1024 }).catch((error) => error);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    await harness.saveText(`throne-${argumentsList[0]}-${Date.now()}`, `$ throne ${argumentsList.join(" ")}\nexit ${result.code ?? 0}\n${output}`);
    return { code: result.code ?? 0, output };
  }

  async function createAgent(name, { model = "haiku", root = repositoryRoot } = {}) {
    const created = await throne(["create-agent", "--model", model, "--effort", "1", "--name", name, "--supervisor", SENDER, "--role", "Agent", "--cwd", harness.repo, "--non-campaign", "--bypass-preset-agent", "--bypass-model", "--bypass-effort", "--prompt", "Reply with only the word ready."], { root });
    const registered = created.output.match(/Spawned "([^"]+)"/u)?.[1];
    if (created.code !== 0 || !registered) throw new Error(`create-agent ${name} failed: ${created.output}`);
    const agents = JSON.parse(await harness.herdr("agent", "list")).result.agents;
    const pane = agents.find((agent) => agent.name === registered)?.pane_id;
    if (!pane) throw new Error(`create-agent registered ${registered} but herdr lists no such agent`);
    const socket = (await spawnRecord(registered)).delivery_socket;
    return { name: registered, pane, socket, output: created.output, screen: () => harness.herdr("pane", "read", pane, "--source", "visible") };
  }

  async function spawnRecord(name) {
    return JSON.parse(await readFile(path.join(harness.dataHome, "data", name, "spawn.json"), "utf8"));
  }

  async function backendLogText() {
    return readFile(backendLog, "utf8").catch(() => "");
  }

  async function close() {
    await killBackend().catch(() => undefined);
    await restoreRegentSkill();
    await harness.saveText("backend-log", await readFile(backendLog, "utf8").catch(() => ""));
    const queue = new Database(path.join(harness.dataHome, "message-queue.sqlite3"), { readonly: true });
    await harness.saveText("message-queue", JSON.stringify(queue.query("select * from work_items").all(), null, 2));
    queue.close();
  }

  await startBackend();
  return { sender, environment, startBackend, killBackend, sendAgent, messageStatus, waitForStatus, backendStarts: () => starts, throne, createAgent, spawnRecord, backendLogText, close };
}
