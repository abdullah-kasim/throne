import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureHarnessHooks } from "../src/ensure-harness-setup/ensure-harness-setup.ts";
import { REAL_DEPS } from "../src/install-services/platform.ts";
import type { InstallServicesDeps } from "../src/install-services/install-services.types.ts";

const HOOK = path.join(import.meta.dirname, "..", "claude-hooks", "memory-read-log.py");
const AGENT = "shadow-readlog-01";
const SESSION = "session-1";
const TRANSCRIPT = "/transcripts/session-1.jsonl";

const scratch = await mkdtemp(path.join(tmpdir(), "memory-read-log-"));
const home = path.join(scratch, "home");
const memoryDirectory = path.join(home, ".memories", "-srv-project");
const memoryFile = path.join(memoryDirectory, "SCRATCH_LESSON.md");
const otherMemoryFile = path.join(memoryDirectory, "OTHER_LESSON.md");
const sharedMemoryDirectory = path.join(home, "shared-memory");
const sharedMemoryFile = path.join(sharedMemoryDirectory, "GLOBAL.md");
const elsewhere = path.join(home, "elsewhere");
const elsewhereFile = path.join(elsewhere, "notes.md");
const agentWorktree = path.join(home, ".throne", "worktrees", "throne", AGENT);
const recallDirectory = path.join(home, ".throne", "data", "recall");
const logPath = path.join(recallDirectory, "memory-reads.jsonl");
const failuresPath = path.join(recallDirectory, "memory-reads.failures.jsonl");
const memoryVersionsDirectory = path.join(recallDirectory, "memory-versions");
const fakeHerdrDirectory = path.join(scratch, "fake-herdr");
const REGENT_PANE = "w1:pRegent";

await mkdir(memoryDirectory, { recursive: true });
await writeFile(memoryFile, "remember the scratch lesson\n");
await writeFile(otherMemoryFile, "another lesson\n");
await mkdir(sharedMemoryDirectory, { recursive: true });
await writeFile(sharedMemoryFile, "a global lesson\n");
await mkdir(elsewhere, { recursive: true });
await writeFile(elsewhereFile, "not a memory\n");
await mkdir(path.join(agentWorktree, "src"), { recursive: true });
await mkdir(path.join(home, ".throne", "data", AGENT), { recursive: true });
await writeFile(path.join(home, ".throne", "data", AGENT, "identity.md"), `# ${AGENT}\n`);

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(recallDirectory, { recursive: true, force: true });
});

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(
  stdin: string,
  configuredDirectories: string[] = ["~/shared-memory"],
  extraEnvironment: Record<string, string> = {},
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [HOOK, ...configuredDirectories], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...extraEnvironment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function toolCall(toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, cwd = agentWorktree) {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: TRANSCRIPT,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  });
}

async function loggedLines(): Promise<Record<string, unknown>[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function silentlyLogged(
  stdin: string,
  configuredDirectories?: string[],
  extraEnvironment?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  assert.deepEqual(await runHook(stdin, configuredDirectories, extraEnvironment), { code: 0, stdout: "", stderr: "" });
  return loggedLines();
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function grepResponse(mode: string, content: string, filenames: string[] = []) {
  return { mode, numFiles: filenames.length, filenames, content, numLines: content.split("\n").length };
}

function withoutTime(line: Record<string, unknown>): Record<string, unknown> {
  assert.match(String(line.at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const { at: _at, ...rest } = line;
  return rest;
}

function bash(command: string, stdout: string, cwd = agentWorktree): string {
  return toolCall("Bash", { command }, { stdout, stderr: "", interrupted: false, isImage: false }, cwd);
}

test("reading a memory file by hand is logged with the session, agent, tool, file and transcript", async () => {
  const lines = await silentlyLogged(
    toolCall(
      "Read",
      { file_path: memoryFile },
      { type: "text", file: { filePath: memoryFile, content: "remember the scratch lesson\n" } },
    ),
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(withoutTime(lines[0]), {
    sessionId: SESSION,
    agentName: AGENT,
    herdrPaneId: null,
    tool: "Read",
    kind: "read",
    target: memoryFile,
    memoryFiles: [memoryFile],
    returnedSomething: true,
    readInFull: true,
    transcriptPath: TRANSCRIPT,
    cwd: agentWorktree,
    memoryFileHashes: { [memoryFile]: sha256Of("remember the scratch lesson\n") },
  });

  const partial = await silentlyLogged(
    toolCall(
      "Read",
      { file_path: sharedMemoryFile, offset: 1, limit: 5 },
      { type: "text", file: { filePath: sharedMemoryFile, content: "a global lesson\n" } },
      elsewhere,
    ),
  );
  assert.equal(partial.length, 2);
  assert.equal(partial[1].agentName, null);
  assert.equal(partial[1].readInFull, false);
  assert.deepEqual(partial[1].memoryFiles, [sharedMemoryFile]);
});

test("a grep inside a memory directory is logged with its search term and whether it returned lines", async () => {
  await silentlyLogged(
    toolCall(
      "Grep",
      { pattern: "scratch", path: memoryDirectory },
      { mode: "files_with_matches", filenames: [memoryFile], numFiles: 1 },
    ),
  );
  await silentlyLogged(
    toolCall("Grep", { pattern: "nothing-matches", path: sharedMemoryDirectory }, { mode: "content", content: "", numLines: 0 }),
  );
  const lines = await silentlyLogged(
    toolCall("Glob", { pattern: "**/*.md", path: memoryDirectory }, { filenames: [memoryFile], numFiles: 1 }),
  );

  assert.deepEqual(
    lines.map((line) => [line.tool, line.kind, line.target, line.memoryFiles, line.returnedSomething, line.readInFull]),
    [
      ["Grep", "search", "scratch", [memoryFile], true, false],
      ["Grep", "search", "nothing-matches", [], false, false],
      ["Glob", "list", "**/*.md", [memoryFile], true, false],
    ],
  );
});

test("a bash grep or cat inside a memory directory is logged", async () => {
  await silentlyLogged(bash(`grep -rn -A 2 scratch ~/.memories/-srv-project 2>/dev/null`, `${memoryFile}:1:remember the scratch lesson\n`));
  await silentlyLogged(bash(`cat "$HOME/.memories/-srv-project/SCRATCH_LESSON.md" | head -5`, "remember the scratch lesson\n"));
  await silentlyLogged(bash("sed -n 1,3p SCRATCH_LESSON.md", "remember the scratch lesson\n", memoryDirectory));
  const lines = await silentlyLogged(bash("ls ~/.memories/ && echo done", "-srv-project\ndone\n"));

  assert.deepEqual(
    lines.map((line) => [line.tool, line.kind, line.target, line.memoryFiles, line.returnedSomething, line.readInFull]),
    [
      ["Bash", "search", "scratch", [memoryFile], true, false],
      ["Bash", "read", memoryFile, [memoryFile], true, true],
      ["Bash", "read", memoryFile, [memoryFile], true, false],
      ["Bash", "list", "ls ~/.memories/ && echo done", [], true, false],
    ],
  );
});

test("running throne recall, rank or sift from bash is logged", async () => {
  const commands = [
    `throne recall "why did the build break" --json`,
    "cd /srv/project && throne rank --query scratch a.md b.md",
    "npm run build | throne sift --query error",
  ];
  for (const command of commands) await silentlyLogged(bash(command, ""));
  const lines = await silentlyLogged(bash("throne-cli recall scratch", `served ${memoryFile}\n`));

  assert.deepEqual(
    lines.map((line) => [line.kind, line.target, line.memoryFiles, line.returnedSomething]),
    [
      ["recall-command", commands[0], [], false],
      ["recall-command", commands[1], [], false],
      ["recall-command", commands[2], [], false],
      ["recall-command", "throne-cli recall scratch", [memoryFile], true],
    ],
  );
});

test("a throne recall from bash records its argument words so the report can read the scope it named", async () => {
  await silentlyLogged(bash(`cd /srv && throne recall --directory ../other --memory-dir ~/.memories/x "fix the build" 2>&1 | head`, ""));
  const lines = await silentlyLogged(bash("throne rank --query scratch a.md", ""));

  assert.deepEqual(lines[0].recallArguments, ["--directory", "../other", "--memory-dir", "~/.memories/x", "fix the build", "2", ">&", "1"]);
  assert.equal("recallArguments" in lines[1], false);
});

test("a throne recall --lint-asks from bash is not logged, so the report never grades the memories it lists", async () => {
  const lintOutput = `${memoryFile}\tbare-narrow-ask\tDoes the task run the build?\n`;
  assert.deepEqual(await silentlyLogged(bash("throne recall --lint-asks > lint.tsv; cat lint.tsv", lintOutput)), []);
  assert.deepEqual(await silentlyLogged(bash("throne-cli recall --lint-asks --global", lintOutput)), []);
});

test("a Grep of a memory directory records the memory files its output named, in every output mode", async () => {
  const responses = [
    grepResponse("content", `${memoryFile}:1:remember the scratch lesson`),
    grepResponse("content", `${memoryFile}:remember the scratch lesson`),
    grepResponse("count", `${memoryFile}:1`),
    grepResponse("files_with_matches", "", [memoryFile]),
  ];
  for (const response of responses) {
    await silentlyLogged(toolCall("Grep", { pattern: "scratch", path: memoryDirectory }, response));
  }
  await silentlyLogged(
    toolCall(
      "Grep",
      { pattern: "scratch", path: ".memories" },
      grepResponse("content", ".memories/-srv-project/SCRATCH_LESSON.md:1:remember the scratch lesson"),
      home,
    ),
  );
  const lines = await silentlyLogged(
    toolCall("Grep", { pattern: "scratch", path: memoryFile }, grepResponse("content", "1:remember the scratch lesson")),
  );

  assert.deepEqual(
    lines.map((line) => [line.kind, line.memoryFiles, line.returnedSomething]),
    Array.from({ length: 6 }, () => ["search", [memoryFile], true]),
  );
});

test("a bash find over a memory directory counts as a search that found the files it printed", async () => {
  await silentlyLogged(bash("find ~/.memories -name '*SCRATCH*'", `${memoryFile}\n`));
  const lines = await silentlyLogged(bash("find . -name '*.md' -newer x", "./SCRATCH_LESSON.md\n", memoryDirectory));

  assert.deepEqual(
    lines.map((line) => [line.kind, line.target, line.memoryFiles, line.returnedSomething]),
    [
      ["search", "find ~/.memories -name '*SCRATCH*'", [memoryFile], true],
      ["search", "find . -name '*.md' -newer x", [memoryFile], true],
    ],
  );
});

test("a bash grep over several memory files records only the files its output named", async () => {
  await silentlyLogged(
    bash("grep -n scratch SCRATCH_LESSON.md OTHER_LESSON.md", "SCRATCH_LESSON.md:1:remember the scratch lesson\n", memoryDirectory),
  );
  const lines = await silentlyLogged(bash(`grep scratch ${memoryFile}`, "remember the scratch lesson\n"));

  assert.deepEqual(
    lines.map((line) => line.memoryFiles),
    [[memoryFile], [memoryFile]],
  );
});

test("every memory file a read or search names is recorded with its content hash and a copy of that version", async () => {
  const firstVersion = "remember the scratch lesson\n";
  const secondVersion = "remember the scratch lesson, rewritten\n";
  try {
    await silentlyLogged(
      bash(
        "grep -rn lesson ~/.memories/-srv-project",
        `${memoryFile}:1:remember the scratch lesson\n${otherMemoryFile}:1:another lesson\n`,
      ),
    );
    await writeFile(memoryFile, secondVersion);
    const lines = await silentlyLogged(
      toolCall("Read", { file_path: memoryFile }, { type: "text", file: { filePath: memoryFile, content: secondVersion } }),
    );

    assert.deepEqual(lines[0].memoryFileHashes, {
      [memoryFile]: sha256Of(firstVersion),
      [otherMemoryFile]: sha256Of("another lesson\n"),
    });
    assert.deepEqual(lines[1].memoryFileHashes, { [memoryFile]: sha256Of(secondVersion) });
    assert.deepEqual(
      (await readdir(memoryVersionsDirectory)).sort(),
      [sha256Of(firstVersion), sha256Of(secondVersion), sha256Of("another lesson\n")].sort(),
    );
    for (const version of [firstVersion, secondVersion]) {
      assert.equal(await readFile(path.join(memoryVersionsDirectory, sha256Of(version)), "utf8"), version);
    }
  } finally {
    await writeFile(memoryFile, firstVersion);
  }
});

test("a read with no throne agent behind its directory still records the herdr pane and transcript directory", async () => {
  await mkdir(fakeHerdrDirectory, { recursive: true });
  const fakeHerdr = path.join(fakeHerdrDirectory, "herdr");
  const agentList = { result: { agents: [{ name: "regent", pane_id: REGENT_PANE }, { name: AGENT, pane_id: "w1:pOther" }] } };
  const withFakeHerdr = (paneId: string) => ({
    PATH: `${fakeHerdrDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HERDR_PANE_ID: paneId,
  });
  const readFromElsewhere = toolCall(
    "Read",
    { file_path: sharedMemoryFile },
    { type: "text", file: { filePath: sharedMemoryFile, content: "a global lesson\n" } },
    elsewhere,
  );

  await writeFile(fakeHerdr, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(agentList)}\nJSON\n`);
  await chmod(fakeHerdr, 0o755);
  await silentlyLogged(readFromElsewhere, undefined, withFakeHerdr(REGENT_PANE));
  await silentlyLogged(readFromElsewhere, undefined, withFakeHerdr("w1:pGone"));

  await writeFile(fakeHerdr, "#!/bin/sh\nexec sleep 5\n");
  const startedAt = Date.now();
  const lines = await silentlyLogged(readFromElsewhere, undefined, withFakeHerdr(REGENT_PANE));

  assert.ok(Date.now() - startedAt < 3000, "a hanging herdr held up the tool call");
  assert.deepEqual(
    lines.map((line) => [line.agentName, line.herdrPaneId, line.transcriptPath]),
    [
      ["regent", REGENT_PANE, TRANSCRIPT],
      [null, "w1:pGone", TRANSCRIPT],
      [null, REGENT_PANE, TRANSCRIPT],
    ],
  );
});

test("the same tools outside any memory directory are not logged", async () => {
  const calls = [
    toolCall("Read", { file_path: elsewhereFile }, { type: "text", file: { filePath: elsewhereFile, content: "not a memory\n" } }),
    toolCall("Grep", { pattern: "memory", path: elsewhere }, { mode: "files_with_matches", filenames: [elsewhereFile], numFiles: 1 }),
    toolCall("Glob", { pattern: `${elsewhere}/**/*.md` }, { filenames: [elsewhereFile], numFiles: 1 }),
    bash("grep -rn memory .", `notes.md:1:not a memory\n`, elsewhere),
    bash(`cat ${elsewhereFile}`, "not a memory\n"),
    bash(`echo ${memoryFile}`, `${memoryFile}\n`),
    bash("throne send-agent alpha recall this", ""),
    toolCall("Edit", { file_path: memoryFile, old_string: "a", new_string: "b" }, {}),
    toolCall("Read", { file_path: sharedMemoryFile }, { type: "text", file: { content: "a global lesson\n" } }),
  ];
  for (const [index, call] of calls.entries()) {
    const configuredDirectories = index === calls.length - 1 ? [] : undefined;
    assert.deepEqual(await silentlyLogged(call, configuredDirectories), [], `call ${index} was logged`);
  }
});

test("the memory read log never blocks a tool call and prints nothing, even when the log directory is missing", async () => {
  await rm(path.join(home, ".throne", "data", "recall"), { recursive: true, force: true });

  const lines = await silentlyLogged(bash(`cat ${memoryFile}`, "remember the scratch lesson\n"));
  assert.equal(lines.length, 1);

  assert.deepEqual(await runHook("not json at all"), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await runHook(toolCall("Bash", { command: "cat 'unbalanced" }, null)), { code: 0, stdout: "", stderr: "" });
});

test("a failure to write the memory read log is counted where the report can see it", async () => {
  await mkdir(logPath, { recursive: true });

  assert.deepEqual(await runHook(bash(`cat ${memoryFile}`, "remember the scratch lesson\n")), {
    code: 0,
    stdout: "",
    stderr: "",
  });

  const failures = (await readFile(failuresPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(failures.length, 1);
  assert.deepEqual(Object.keys(failures[0]).sort(), ["at", "error"]);
  assert.match(failures[0].error, /memory-reads\.jsonl/);
});

function settingsMachine(): { deps: InstallServicesDeps; settings: { text: string | null } } {
  const settings = { text: null as string | null };
  const codexHooks = new Map<string, string>();
  const deps = {
    ...REAL_DEPS,
    claudeSettingsPath: () => path.join(home, ".claude", "settings.json"),
    readClaudeSettings: async () => settings.text,
    writeClaudeSettings: async (_settingsPath: string, content: string) => {
      settings.text = content;
    },
    inspectInstalledUnit: async (targetPath: string) => {
      const content = codexHooks.get(targetPath);
      return content === undefined ? { kind: "missing" } : { kind: "file", content };
    },
    writeUnitFile: async (targetPath: string, content: string) => {
      codexHooks.set(targetPath, content);
    },
  } as InstallServicesDeps;
  return { deps, settings };
}

async function throneRootWithRecallSection(name: string, recallSection: string): Promise<string> {
  const throneRoot = path.join(scratch, name);
  await mkdir(throneRoot, { recursive: true });
  await writeFile(path.join(throneRoot, "package.json"), '{"type":"module"}');
  await writeFile(path.join(throneRoot, "config.user.ts"), `export default { recall: ${recallSection} };\n`);
  return throneRoot;
}

function memoryReadLogCommands(settingsText: string | null): { matcher: string; command: string }[] {
  const settings = JSON.parse(settingsText ?? "{}") as {
    hooks: { PostToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  return settings.hooks.PostToolUse.flatMap((entry) =>
    entry.hooks
      .filter((hook) => hook.command.includes("memory-read-log.py"))
      .map((hook) => ({ matcher: entry.matcher, command: hook.command })),
  );
}

function memoryReadLogState(results: { hook: string; state: string }[]): string | undefined {
  return results.find((result) => result.hook === "claude memory read log")?.state;
}

test("every throne launch registers the memory read log hook once, beside the two guards", async () => {
  const machine = settingsMachine();
  const throneRoot = await throneRootWithRecallSection("throne-one", `{ globalMemoryDirectories: ["~/shared-memory"] }`);

  const first = await ensureHarnessHooks(throneRoot, machine.deps);
  assert.deepEqual(
    first.map((result) => [result.hook, result.state]),
    [
      ["claude scratch path guard", "added"],
      ["claude skill write guard", "added"],
      ["claude memory read log", "added"],
      ["claude jev fence", "added"],
      ["codex session start", "added"],
    ],
  );
  assert.deepEqual(memoryReadLogCommands(machine.settings.text), [
    {
      matcher: "Read|Grep|Glob|Bash",
      command: `python3 "${path.join(throneRoot, "claude-hooks", "memory-read-log.py")}" "~/shared-memory"`,
    },
  ]);

  assert.equal(memoryReadLogState(await ensureHarnessHooks(throneRoot, machine.deps)), "unchanged");
  assert.equal(memoryReadLogCommands(machine.settings.text).length, 1);

  const movedRoot = await throneRootWithRecallSection("throne-two", "{ globalMemoryDirectories: [] }");
  assert.equal(memoryReadLogState(await ensureHarnessHooks(movedRoot, machine.deps)), "added");
  assert.deepEqual(memoryReadLogCommands(machine.settings.text), [
    {
      matcher: "Read|Grep|Glob|Bash",
      command: `python3 "${path.join(movedRoot, "claude-hooks", "memory-read-log.py")}"`,
    },
  ]);

  const unreadableRoot = await throneRootWithRecallSection("throne-unreadable", "{ globalMemoryDirectories: 7 }");
  assert.equal(memoryReadLogState(await ensureHarnessHooks(unreadableRoot, machine.deps)), "added");
  assert.equal(
    memoryReadLogCommands(machine.settings.text)[0].command,
    `python3 "${path.join(unreadableRoot, "claude-hooks", "memory-read-log.py")}"`,
  );
});
