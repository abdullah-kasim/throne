import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

export interface ChildRun {
  child: ChildProcess;
  firstLine: Promise<string>;
  exited: Promise<number | null>;
}

export function lockTestProcesses(homePrefix: string) {
  const scratchHomes: string[] = [];
  const children: ChildProcess[] = [];

  after(async () => {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(scratchHomes.map((home) => rm(home, { recursive: true, force: true })));
  });

  async function scratchThroneHome(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), homePrefix));
    scratchHomes.push(home);
    return home;
  }

  function runChild(script: string, environment: NodeJS.ProcessEnv = process.env): ChildRun {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"], env: environment });
    children.push(child);
    const firstLine = new Promise<string>((resolve) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) resolve(output.split("\n")[0] ?? "");
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, firstLine, exited };
  }

  return { scratchThroneHome, runChild };
}

export async function assertEnteredOneAtATime(contenders: ChildRun[], journal: string, entryCount: number): Promise<void> {
  assert.deepEqual(
    await Promise.all(contenders.map((each) => each.exited)),
    contenders.map(() => 0),
  );
  const entries = (await readFile(journal, "utf8")).trim().split("\n");
  assert.equal(entries.length, entryCount * 2);
  entries.forEach((entry, index) => assert.equal(entry, index % 2 === 0 ? "enter" : "leave"));
}
