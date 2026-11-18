import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildLaunchArgv } from "../../src/harness-routing/harness.ts";
import { launchIsolatedHerdrSession } from "../../src/herdr-update/herdr-update-session.ts";
import { ownedHerdrClientPath } from "../../src/herdr/herdr-client.ts";
import { throneAccountsDirectory } from "../../src/shared-policy/throne-home.ts";
import {
  startPiProviderStandIn,
  writeStandInAgentDirectory,
} from "../../test/support/pi-provider-stand-in/pi-provider-stand-in.mjs";

const runFile = promisify(execFile);

export const THRONE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PIY_PATH = path.join(THRONE_ROOT, "bin", "piy");
export const THRONE_CLI_PATH = path.join(THRONE_ROOT, "bin", "throne-cli");
export const LIVE_HERDR_SESSION_NAME = "throne";
const RECONCILIATION_MODULE = path.join(THRONE_ROOT, "src", "throne-startup", "throne-startup-reconciliation.service.ts");
export const STAND_IN_KEY = "stand-in-key-not-a-real-secret";

const VENDORED_PI_ENTRY = path.join(
  THRONE_ROOT,
  "vendor/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);

export function piEntryPath(environment = process.env) {
  return environment.PI_BIN?.trim() || VENDORED_PI_ENTRY;
}

const PI_SCROLLED_BACK_HINT = "Jump to latest message";
const PI_JUMP_TO_LATEST_SEQUENCE = "\x1b[1;5F";
const PI_EXIT_MARKER = "pi exited with status";

export function piStartState(paneText, expected) {
  const exited = paneText.match(new RegExp(`${PI_EXIT_MARKER} (\\d+)`));
  if (exited !== null) {
    const piyMessage = paneText.match(/^piy: .*$/m);
    const reason = piyMessage === null ? "" : `: ${piyMessage[0].trim()}`;
    return { state: "exited", cause: `pi exited with status ${exited[1]} before drawing ${expected}${reason}` };
  }
  const squeezed = paneText.replace(/\s+/g, "");
  const echoedCommandEnd = `echo"${PI_EXIT_MARKER.replace(/\s+/g, "")}$?"`;
  const commandEnd = squeezed.lastIndexOf(echoedCommandEnd);
  const afterCommand = commandEnd === -1 ? squeezed : squeezed.slice(commandEnd + echoedCommandEnd.length);
  return afterCommand.includes(expected) ? { state: "drawn" } : { state: "waiting" };
}

export function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const LIVE_COURT_VARIABLE_PREFIXES = ["HERDR_", "THRONE_AGENT_"];

export function environmentWithoutTheLiveCourt(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !LIVE_COURT_VARIABLE_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );
}

export async function pollUntil(read, matches, timeoutMilliseconds, intervalMilliseconds = 250) {
  const deadline = Date.now() + timeoutMilliseconds;
  let value = await read();
  while (!matches(value)) {
    if (Date.now() >= deadline) return { found: false, value };
    await pause(intervalMilliseconds);
    value = await read();
  }
  return { found: true, value };
}

export function skippedLineReason(line, flags) {
  if (line.realProvider && !flags.realProvider) return "real provider line; run with --real-provider";
  if (line.realHarnesses && !flags.realHarnesses) return "spends real Claude and Codex subscription tokens; run with --real-harnesses";
  return null;
}

function randomSuffix() {
  return randomBytes(4).toString("hex");
}

export async function runCommand(executable, argumentsList, options = {}) {
  try {
    const result = await runFile(executable, argumentsList, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout ?? 60_000,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

export async function createLineWorkspace(lineDirectory) {
  const scratch = await mkdtemp(path.join(os.homedir(), "tmp", "pi-evidence-"));
  const dataHome = path.join(scratch, "throne-home");
  const liveRoot = path.join(scratch, "live-root");
  const repository = path.join(scratch, "repository");
  const ledger = path.join(scratch, "ledger");
  await Promise.all([dataHome, liveRoot, repository, ledger].map((folder) => mkdir(folder, { recursive: true })));
  await mkdir(path.join(dataHome, "config"), { recursive: true });
  await runCommand("git", ["init", "-q", repository]);
  await runCommand("git", ["-C", repository, "-c", "user.name=pi-evidence", "-c", "user.email=pi-evidence@localhost", "commit", "-q", "--allow-empty", "-m", "start"]);
  const cleanups = [];
  const savedPanes = [];
  const savedFiles = [];
  let herdrSession;

  const workspace = {
    scratch,
    dataHome,
    liveRoot,
    repository,
    ledger,
    lineDirectory,
    sessionEnvironment: {},
    supervisorHarness: "claude",
    throneEnvironment(extra = {}) {
      return {
        ...environmentWithoutTheLiveCourt(process.env),
        THRONE_DATA_HOME: dataHome,
        THRONE_LIVE_ROOT: liveRoot,
        ...(herdrSession === undefined ? {} : { THRONE_HERDR_SESSION_NAME_OVERRIDE: herdrSession.sessionName }),
        ...extra,
      };
    },
    async throneCli(argumentsList, extra = {}) {
      return runCommand(THRONE_CLI_PATH, argumentsList, { env: workspace.throneEnvironment(extra), cwd: repository });
    },
    async writeUserConfig(text) {
      const configPath = path.join(dataHome, "config", "config.user.ts");
      await writeFile(configPath, text);
      return configPath;
    },
    async saveText(name, text) {
      const filePath = path.join(lineDirectory, name);
      await writeFile(filePath, text);
      savedFiles.push(filePath);
      return filePath;
    },
    async herdr() {
      if (herdrSession !== undefined) return herdrSession;
      const sessionName = `pi-evidence-${randomSuffix()}`;
      if (sessionName === LIVE_HERDR_SESSION_NAME) throw new Error("refusing the live herdr session");
      const executable = ownedHerdrClientPath(process.env);
      const handle = await launchIsolatedHerdrSession(executable, sessionName, {
        ...environmentWithoutTheLiveCourt(process.env),
        THRONE_DATA_HOME: dataHome,
        THRONE_LIVE_ROOT: liveRoot,
        THRONE_HERDR_SESSION_NAME_OVERRIDE: sessionName,
        PI_OFFLINE: "1",
        PI_BIN: piEntryPath(),
        ...workspace.sessionEnvironment,
      });
      cleanups.push(handle.cleanup);
      const call = async (...argumentsList) => {
        const result = await runCommand(executable, ["--session", sessionName, ...argumentsList]);
        if (result.code !== 0) throw new Error(`herdr ${argumentsList.join(" ")}: ${result.stderr.trim()}`);
        return result.stdout;
      };
      herdrSession = {
        sessionName,
        call,
        async openPane(cwd) {
          await call("workspace", "create", "--cwd", cwd, "--no-focus");
          const panes = JSON.parse(await call("pane", "list")).result.panes;
          return panes[panes.length - 1].pane_id;
        },
        async readPane(paneId) {
          return call("pane", "read", paneId, "--source", "recent", "--lines", "400");
        },
        async processInfo(paneId) {
          return JSON.parse(await call("pane", "process-info", "--pane", paneId)).result.process_info;
        },
        async savePane(paneId, name) {
          const text = await herdrSession.readPane(paneId);
          const filePath = path.join(lineDirectory, name);
          await writeFile(filePath, text);
          savedPanes.push(filePath);
          return text;
        },
        async runPi(paneId, command) {
          const watched = `${command}; echo "${PI_EXIT_MARKER} $?"`;
          await call("pane", "run", paneId, watched);
        },
        async waitForPi(paneId, expected, timeoutMilliseconds = 30_000) {
          const deadline = Date.now() + timeoutMilliseconds;
          let text = "";
          while (Date.now() < deadline) {
            text = await herdrSession.readPane(paneId);
            const started = piStartState(text, expected);
            if (started.state === "drawn") return { found: true, text };
            if (started.state === "exited") return { found: false, text, cause: started.cause };
            await pause(500);
          }
          return { found: false, text, cause: `pi did not draw ${expected} within ${timeoutMilliseconds / 1000}s` };
        },
        async waitForPaneText(paneId, matches, timeoutMilliseconds = 30_000) {
          const readLatest = async () => {
            const text = await herdrSession.readPane(paneId);
            if (!matches(text) && text.includes(PI_SCROLLED_BACK_HINT)) await call("pane", "send-text", paneId, PI_JUMP_TO_LATEST_SEQUENCE);
            return text;
          };
          const polled = await pollUntil(readLatest, matches, timeoutMilliseconds, 500);
          return { found: polled.found, text: polled.value };
        },
        async typeAndSubmit(paneId, text, timeoutMilliseconds = 15_000) {
          await call("pane", "send-text", paneId, text);
          const shown = await herdrSession.waitForPaneText(paneId, (pane) => pane.includes(text), timeoutMilliseconds);
          if (!shown.found) throw new Error(`the pane never showed the typed text "${text}" within ${timeoutMilliseconds / 1000}s`);
          await call("pane", "send-keys", paneId, "Enter");
        },
      };
      return herdrSession;
    },
    async standIn(options) {
      const server = await startPiProviderStandIn(options);
      cleanups.push(() => server.close());
      return server;
    },
    async piAgentDirectory(baseUrl) {
      const agentDirectory = path.join(ledger, "pi-agent");
      await writeStandInAgentDirectory(agentDirectory, baseUrl, writeFile, mkdir);
      return agentDirectory;
    },
    async writePiAdmittingConfig() {
      const example = await readFile(path.join(THRONE_ROOT, "config.user.example.ts"), "utf8");
      const pi = "{ harness: 'pi', model: 'flash' }, { harness: 'pi', model: 'pro' }, { harness: 'claude', model: 'opus' }";
      return workspace.writeUserConfig(
        example
          .replace(
            "activePlanPresetName: 'OpusOnly',",
            `activePlanPresetName: 'Evidence',\n    customPlanPresets: { Evidence: { alpha: [${pi}], shadow: [${pi}], shadowSlice99: [${pi}] } },`,
          )
          .replace(/  ntfy: \{[^}]*\},\n/, ""),
      );
    },
    async addDeepseekAccount(key = STAND_IN_KEY) {
      const sourceKeyFile = path.join(scratch, "deepseek-source-key");
      await writeFile(sourceKeyFile, `${key}\n`, { mode: 0o600 });
      const added = await workspace.throneCli(["account", "add", "deepseek", "--provider", "deepseek", "--key-file", sourceKeyFile]);
      await workspace.saveText("account-add.txt", `exit ${added.code}\n${added.stdout}${added.stderr}`);
      return path.join(dataHome, "accounts", "pi", "deepseek", "api-key");
    },
    async throneCliFromLiveRoot(argumentsList, extra = {}) {
      await mkdir(path.join(liveRoot, "src"), { recursive: true });
      await writeFile(path.join(liveRoot, "src", "tools.ts"), "");
      await runCommand("git", ["init", "-q", liveRoot]);
      return runCommand(THRONE_CLI_PATH, argumentsList, { env: workspace.throneEnvironment(extra), cwd: liveRoot, timeout: 180_000 });
    },
    async createPiAgent(name, model, baseUrl, cwd = repository, { role = "Shadow", supervisor: supervisorName = "alpha-pievidence-01", prompt } = {}) {
      const herdr = await workspace.herdr();
      const workspaces = JSON.parse(await herdr.call("workspace", "list")).result.workspaces ?? [];
      if (workspaces.length === 0) await herdr.call("workspace", "create", "--cwd", repository, "--no-focus");
      const supervisor = path.join(dataHome, "data", "alpha-pievidence-01");
      await mkdir(supervisor, { recursive: true });
      await writeFile(
        path.join(supervisor, "spawn.json"),
        `${JSON.stringify({ harness: workspace.supervisorHarness, model: workspace.supervisorHarness === "pi" ? "flash" : "opus", effort: 3, cwd: repository, objective_code: "pievidence" })}\n`,
      );
      await workspace.writePiAdmittingConfig();
      const result = await workspace.throneCliFromLiveRoot(
        ["create-agent", "--model", model, "--role", role, "--name", name, "--supervisor", supervisorName, "--non-campaign", "--cwd", cwd, ...(prompt === undefined ? [] : ["--prompt", prompt])],
        { PI_BIN: piEntryPath(), PI_OFFLINE: "1", ...(baseUrl === undefined ? {} : { THRONE_PI_PROVIDER_BASE_URL: baseUrl }) },
      );
      await workspace.saveText(`create-agent-${name}.txt`, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
      return result;
    },
    async launchPiAgent(name, model, standInOptions, cwd = repository) {
      const standIn = await workspace.standIn(standInOptions);
      await workspace.addDeepseekAccount();
      const result = await workspace.createPiAgent(name, model, standIn.baseUrl, cwd);
      const herdr = await workspace.herdr();
      const panes = JSON.parse(await herdr.call("pane", "list")).result.panes;
      const paneId = panes.filter((pane) => pane.agent === "pi").at(-1)?.pane_id;
      const record = await workspace.spawnRecord(name);
      return { standIn, result, herdr, paneId, record };
    },
    async courtResumeOptions(name, baseUrl) {
      const script = `
        const { resumeOrphan, REAL_RESUME_CONTRACT } = await import(${JSON.stringify(RECONCILIATION_MODULE)});
        await resumeOrphan(${JSON.stringify(name)}, {
          ...REAL_RESUME_CONTRACT,
          resumeRegisteredAgentInRestoredTab: async (_name, options) => { process.stdout.write(JSON.stringify(options)); return { kind: "new-tab-launched" }; },
          deliverOpeningPrompt: async () => {},
          log: () => {},
          warn: (message) => process.stderr.write(message),
        });`;
      const result = await runCommand(process.execPath, ["-e", script], {
        env: workspace.throneEnvironment({ THRONE_PI_PROVIDER_BASE_URL: baseUrl }),
        cwd: THRONE_ROOT,
      });
      await workspace.saveText(`court-resume-${name}.txt`, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
      return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
    },
    async runCourtResume(paneId, options) {
      const herdr = await workspace.herdr();
      const argv = [PIY_PATH, ...options.argv.slice(1)];
      await herdr.call("pane", "run", paneId, workspace.piLaunchCommand(argv, options.env ?? {}));
      return argv;
    },
    async spawnRecord(name) {
      try {
        return JSON.parse(await readFile(path.join(dataHome, "data", name, "spawn.json"), "utf8"));
      } catch {
        return null;
      }
    },
    piLaunchCommand(argumentsList, environment) {
      const assignments = Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`);
      return ["env", ...assignments, ...argumentsList.map(shellQuote)].join(" ");
    },
    evidence() {
      return { pane_text_paths: [...savedPanes], files: [...savedFiles] };
    },
    async close() {
      for (const cleanup of cleanups.reverse()) {
        await Promise.resolve().then(cleanup).catch(() => undefined);
      }
      await rm(scratch, { recursive: true, force: true });
    },
  };
  return workspace;
}

export async function piProcessOfPane(herdr, paneId) {
  const info = await herdr.processInfo(paneId);
  const entry = (info.foreground_processes ?? []).find((candidate) => (candidate.argv ?? []).some((part) => part.includes("pi-coding-agent")));
  if (entry === undefined) return null;
  const readProc = (file) => readFile(`/proc/${entry.pid}/${file}`, "utf8").then((text) => text.split("\0"), () => []);
  const environment = Object.fromEntries((await readProc("environ")).filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  return { pid: entry.pid, cmdline: (await readProc("cmdline")).join(" "), environment };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function deepseekKeyForRealProvider() {
  return (await readFile(path.join(throneAccountsDirectory(), "pi", "deepseek", "api-key"), "utf8")).trim();
}

export function notBuiltYet(lineIds, owner) {
  return lineIds.map((id) => ({
    id,
    async run() {
      return { verdict: "NOT VERIFIED", observed: `not built yet: slice ${owner} fills this line` };
    },
  }));
}

export async function runStandInPi(workspace, herdr, paneId, agentDirectory, environment) {
  const argv = buildLaunchArgv({ harness: "pi", model: "flash", effort: 3, piSession: { sessionId: randomUUID(), sessionDirectory: path.join(workspace.ledger, "pi-sessions") } });
  argv[0] = PIY_PATH;
  await herdr.runPi(paneId, workspace.piLaunchCommand(argv, {
    THRONE_DATA_HOME: workspace.dataHome,
    THRONE_LIVE_ROOT: workspace.liveRoot,
    THRONE_HERDR_SESSION_NAME_OVERRIDE: herdr.sessionName,
    DEEPSEEK_API_KEY: STAND_IN_KEY,
    PI_OFFLINE: "1",
    PI_BIN: piEntryPath(),
    PI_CODING_AGENT_DIR: agentDirectory,
    ...environment,
  }));
}
