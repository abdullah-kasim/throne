import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { vendoredHarnessBinaryDirectory } from "../herdr/herdr-launch-command.ts";
import { sessionEnvExportLines } from "../throne-startup/session-env-export.ts";
import {
  THRONE_SHELL_BLOCK_START,
  throneSessionFilePath,
  throneSessionFileText,
  throneShellBlock,
  upsertThroneShellBlock,
} from "./throne-shell-block.ts";

const BASE_PATH = "/usr/bin:/bin";
const REPORT_HARNESS_ENVIRONMENT = [
  'echo "claude=$(type -P claude)"',
  'echo "git=$(type -P git)"',
  'echo "THRONE_LIVE_ROOT=${THRONE_LIVE_ROOT-unset}"',
  'echo "CLAUDE_BIN=${CLAUDE_BIN-unset}"',
  'echo "CODEX_BIN=${CODEX_BIN-unset}"',
  'echo "PATH=$PATH"',
].join("; ");

let scratch: string;
let liveRoot: string;
let decoyBin: string;
let throneRc: string;

const runFile = promisify(execFile);

async function writeExecutable(file: string): Promise<void> {
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o755);
}

async function writeStubBin(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeExecutable(path.join(directory, "claude"));
  await writeExecutable(path.join(directory, "git"));
}

async function writeRc(name: string, text: string): Promise<string> {
  const file = path.join(scratch, name);
  await writeFile(file, text);
  return file;
}

async function runBash(script: string, environment: Record<string, string> = {}): Promise<string> {
  const { stdout } = await runFile("bash", ["--noprofile", "--norc", "-c", script], {
    env: { HOME: scratch, PATH: `${decoyBin}:${BASE_PATH}`, ...environment },
  });
  return stdout;
}

function reportedValues(output: string): Map<string, string> {
  return new Map(
    output
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "throne-shell-block-"));
  liveRoot = path.join(scratch, "live root");
  decoyBin = path.join(scratch, "decoy-bin");
  await writeStubBin(path.join(liveRoot, "bin"));
  await writeStubBin(decoyBin);
  await mkdir(path.dirname(throneSessionFilePath(liveRoot)), { recursive: true });
  await writeFile(throneSessionFilePath(liveRoot), throneSessionFileText(liveRoot));
  throneRc = await writeRc("throne.bashrc", upsertThroneShellBlock("", throneShellBlock(liveRoot)));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("a shell in the throne herdr session finds throne's claude and git first and the pinned harness binaries", async () => {
  const values = reportedValues(
    await runBash(`. '${throneRc}'; ${REPORT_HARNESS_ENVIRONMENT}`, { HERDR_SESSION: "throne" }),
  );
  assert.equal(values.get("claude"), path.join(liveRoot, "bin", "claude"));
  assert.equal(values.get("git"), path.join(liveRoot, "bin", "git"));
  assert.equal(values.get("THRONE_LIVE_ROOT"), liveRoot);
  assert.equal(values.get("CLAUDE_BIN"), path.join(vendoredHarnessBinaryDirectory(liveRoot), "claude"));
  assert.equal(values.get("CODEX_BIN"), path.join(vendoredHarnessBinaryDirectory(liveRoot), "codex"));
});

test("a shell outside the throne herdr session is left exactly as it was", async () => {
  const reportShellState = `${REPORT_HARNESS_ENVIRONMENT}; echo "PROMPT_COMMAND=\${PROMPT_COMMAND-unset}"; declare -F`;
  const untouched = await runBash(`. /dev/null; ${reportShellState}`);
  const outsideTheThroneSession: Array<Record<string, string>> = [{}, { HERDR_SESSION: "another-session" }];
  for (const environment of outsideTheThroneSession) {
    assert.equal(await runBash(`. '${throneRc}'; ${reportShellState}`, environment), untouched);
  }
});

test("throne's bin stays first after a prompt cycle even when mise re-prepends its paths", async () => {
  const miseLikeRc = [
    `_mise_hook() { PATH='${decoyBin}':"$PATH"; }`,
    'PROMPT_COMMAND="_mise_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
    "",
  ].join("\n");
  const rc = await writeRc("mise.bashrc", upsertThroneShellBlock(miseLikeRc, throneShellBlock(liveRoot)));
  const promptCycle = 'eval "$PROMPT_COMMAND"';
  const output = await runBash(
    `. '${rc}'; . '${rc}'; ${promptCycle}; ${promptCycle}; ${REPORT_HARNESS_ENVIRONMENT}; printf 'PROMPT_COMMAND=%q\\n' "$PROMPT_COMMAND"`,
    { HERDR_SESSION: "throne" },
  );
  const values = reportedValues(output);
  const liveBin = path.join(liveRoot, "bin");
  assert.equal(values.get("claude"), path.join(liveBin, "claude"));
  assert.equal(values.get("PATH")?.split(":")[0], liveBin);
  assert.equal(values.get("PATH")?.split(":").filter((entry) => entry === liveBin).length, 1);
  assert.equal(values.get("PROMPT_COMMAND")?.match(/throne_put_live_bin_first/g)?.length, 1);
});

test("adding the throne block to a shell rc twice leaves one block at the end", () => {
  const rcText = "alias ll='ls -l'";
  const block = throneShellBlock(liveRoot);
  const once = upsertThroneShellBlock(rcText, block);
  const twice = upsertThroneShellBlock(once, block);
  assert.equal(once, `${rcText}\n${block}`);
  assert.equal(twice, once);
  assert.equal(twice.split(THRONE_SHELL_BLOCK_START).length - 1, 1);
});

test("an existing throne block in a shell rc is replaced where it stands", () => {
  const linesBeforeBlock = "export EDITOR=vim\n";
  const linesAfterBlock = "alias ll='ls -l'\n";
  const rcText = `${linesBeforeBlock}${throneShellBlock("/old/throne")}${linesAfterBlock}`;
  const block = throneShellBlock(liveRoot);
  assert.equal(upsertThroneShellBlock(rcText, block), `${linesBeforeBlock}${block}${linesAfterBlock}`);
});

test("the session start exports and the throne shell file export the same values", async () => {
  const sessionEnvFile = await writeRc("session.env", `${sessionEnvExportLines({ liveRoot }).join("\n")}\n`);
  const startingPath = `${BASE_PATH}:${path.join(liveRoot, "bin")}`;
  const fromSessionStart = await runBash(`. '${sessionEnvFile}'; ${REPORT_HARNESS_ENVIRONMENT}`, {
    PATH: startingPath,
  });
  const fromThroneShell = await runBash(`. '${throneRc}'; ${REPORT_HARNESS_ENVIRONMENT}`, {
    PATH: startingPath,
    HERDR_SESSION: "throne",
  });
  assert.equal(fromThroneShell, fromSessionStart);
});
