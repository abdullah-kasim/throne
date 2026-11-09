import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildAndPublishDist, compileWebIntoStaging } from "./build-and-publish-dist.mjs";
import { checkDistIsFresh } from "./dist-staleness-guard.mjs";

let scratch: string;
let generationRoot: string;
let sourceRoot: string;

function writeFile(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeFakeBackendOutput(stagingDir: string): void {
  writeFile(path.join(stagingDir, "src", "tools.js"), "export {};\n");
  writeFile(path.join(stagingDir, "test", "fixtures", "send-agent-process-mutex-runner.js"), "export {};\n");
  mkdirSync(path.join(stagingDir, "systemd"), { recursive: true });
}

function writeWebConfig(name: string, entryScript: string): string {
  const webDirectory = path.join(scratch, name);
  writeFile(path.join(webDirectory, "index.html"), `<!doctype html><script type="module" src="${entryScript}"></script>\n`);
  writeFile(path.join(webDirectory, "main.js"), "document.title = 'invented';\n");
  const configPath = path.join(webDirectory, "vite.config.mjs");
  writeFile(configPath, `export default { root: ${JSON.stringify(webDirectory)}, logLevel: "silent" };\n`);
  return configPath;
}

function publishUsing(webConfigPath: string): Promise<void> {
  return buildAndPublishDist(
    (stagingDir: string) => {
      writeFakeBackendOutput(stagingDir);
      compileWebIntoStaging(stagingDir, webConfigPath);
    },
    generationRoot,
    sourceRoot,
  );
}

function distLink(): string {
  return path.join(generationRoot, "dist");
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "web-build-publishing-"));
  generationRoot = path.join(scratch, "generations");
  sourceRoot = path.join(scratch, "source");
  mkdirSync(generationRoot);
  writeFile(path.join(sourceRoot, "web", "src", "main.tsx"), "export {};\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("the web app is published in the same generation as the backend", async () => {
  await publishUsing(writeWebConfig("working-web", "/main.js"));

  const generation = readlinkSync(distLink());
  assert.match(readFileSync(path.join(generationRoot, generation, "web", "index.html"), "utf8"), /<script/);
  assert.equal(existsSync(path.join(generationRoot, generation, "src", "tools.js")), true);
});

test("a failed web build leaves the previous generation published", async () => {
  await publishUsing(writeWebConfig("working-web", "/main.js"));
  const previousGeneration = readlinkSync(distLink());

  await assert.rejects(publishUsing(writeWebConfig("broken-web", "/no-such-entry.js")), /vite build/);

  assert.equal(readlinkSync(distLink()), previousGeneration);
  assert.equal(existsSync(path.join(generationRoot, previousGeneration, "web", "index.html")), true);
});

test("a change under web/ makes dist stale", async () => {
  await publishUsing(writeWebConfig("working-web", "/main.js"));
  assert.equal(checkDistIsFresh(sourceRoot, distLink()).ok, true);

  writeFile(path.join(sourceRoot, "web", "src", "main.tsx"), "export const changed = true;\n");

  const result = checkDistIsFresh(sourceRoot, distLink());
  assert.equal(result.ok, false);
  assert.match(result.message, /web\/src\/main\.tsx/);
});
