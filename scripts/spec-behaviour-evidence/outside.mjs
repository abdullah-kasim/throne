import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceLine } from "../spec-behaviour-evidence-line.mjs";
import { NOT_OURS_EMPTY } from "../spec-behaviour-evidence-fixture.mjs";

const tools = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), "dist", "src", "tools.js");

function lockArguments(repository) {
  return [tools, "spec-lock", "--repository", repository, "--ttl", "1m"];
}

function holdLock(repository) {
  const holder = spawn(process.execPath, lockArguments(repository), { stdio: ["ignore", "pipe", "pipe"] });
  let printed = "";
  const collect = (chunk) => void (printed += chunk);
  holder.stdout.on("data", collect);
  holder.stderr.on("data", collect);
  const ended = new Promise((resolve) => holder.once("exit", (code) => resolve(code)));
  const locked = new Promise((resolve, reject) => {
    holder.stdout.on("data", () => {
      const folder = /folder: (.+)\n/.exec(printed)?.[1];
      if (folder !== undefined) resolve(folder);
    });
    ended.then(() => reject(new Error(`the lock process ended without taking the lock: ${printed}`)));
  });
  return {
    locked,
    async release() {
      holder.kill("SIGTERM");
      return { code: await ended, printed };
    },
  };
}

function tryLock(repository) {
  return new Promise((resolve) => {
    execFile(process.execPath, lockArguments(repository), (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : error.code, printed: stdout + stderr });
    });
  });
}

export async function run(context) {
  const repository = context.repositories[NOT_OURS_EMPTY];
  const command = `throne spec-lock --repository ${repository} --ttl 1m, twice at once`;
  const first = holdLock(repository);
  const folder = context.guardPath(await first.locked);
  writeFileSync(context.guardPath(path.join(folder, "first-writer.md")), "first writer\n");
  const refused = await tryLock(repository);
  const firstEnd = await first.release();
  const second = holdLock(repository);
  const secondFolder = await second.locked;
  writeFileSync(context.guardPath(path.join(secondFolder, "second-writer.md")), "second writer\n");
  const secondEnd = await second.release();
  const kept = ["first-writer.md", "second-writer.md"].map((file) => readFileSync(path.join(folder, file), "utf8").trim());
  const holderName = /locked by (.+?) until/.exec(firstEnd.printed)?.[1];
  const passed =
    refused.code === 1 &&
    holderName !== undefined &&
    refused.printed.includes(`locked by ${holderName}`) &&
    firstEnd.code === 0 &&
    secondEnd.code === 0 &&
    secondFolder === folder &&
    kept.join(",") === "first writer,second writer";
  return [
    evidenceLine(
      "E1",
      command,
      "the second writer exits 1 naming the holder; after release it takes the lock; both writers' files are kept",
      `refused exit ${refused.code}: ${refused.printed.trim()} | first exit ${firstEnd.code}, second exit ${secondEnd.code} | kept: ${kept.join(", ")}`,
      passed,
    ),
  ];
}
