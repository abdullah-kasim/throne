import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { PRESET_NAMES, PRESETS, VIEWPORTS } from "./presets.mjs";
import { networkSpecLine, storeSpecLines } from "./spec-lines.mjs";

const REFERENCE_COMMIT = "242c5554";
const PINNED_NOW = "2026-11-12T15:00:00.000Z";
const DEFAULT_PORT = 18430;
const SERVER_START_LIMIT_MS = 60_000;
const SETTLE_MS = 1500;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidenceFolder = path.join(repositoryRoot, "scripts", "where-i-stand-evidence");

const { values } = parseArgs({
  options: {
    preset: { type: "string", default: "all" },
    out: { type: "string" },
    port: { type: "string", default: String(DEFAULT_PORT) },
    "data-home": { type: "string" },
    viewport: { type: "string", default: "both" },
    "reference-tree": { type: "string", default: path.join(os.homedir(), ".cache", `throne-pagedb-reference-${REFERENCE_COMMIT}`) },
    "freeze-reference": { type: "string" },
  },
});

const startedServers = new Set();

function fail(message) {
  for (const server of startedServers) server.kill("SIGKILL");
  console.error(`where-i-stand evidence: ${message}`);
  process.exit(1);
}

const presetNames = values.preset === "all" ? PRESET_NAMES : values.preset.split(",");
for (const name of presetNames) if (!PRESETS[name]) fail(`unknown preset ${name}; the presets are ${PRESET_NAMES.join(", ")}`);
const viewportNames = values.viewport === "both" ? Object.keys(VIEWPORTS) : [values.viewport];
for (const name of viewportNames) if (!VIEWPORTS[name]) fail(`unknown viewport ${name}; use desktop, phone or both`);
if (!values.out) fail("--out <folder> is required");
const out = path.resolve(values.out);
const basePort = Number(values.port);
const dataHome = path.resolve(values["data-home"] ?? (await mkdtemp(path.join(os.homedir(), "tmp", "where-i-stand-evidence-"))));
const referenceTree = path.resolve(values["reference-tree"]);
const productWebRoot = path.join(repositoryRoot, "dist", "web");
if (!existsSync(path.join(productWebRoot, "index.html"))) fail(`${productWebRoot} is missing; run \`bun run build\` first`);

function buildReferenceTree() {
  if (existsSync(path.join(referenceTree, "dist", "web", "index.html"))) return;
  console.error(`where-i-stand evidence: building the reference page from ${REFERENCE_COMMIT} in ${referenceTree}`);
  const steps = [
    ["git", ["-C", repositoryRoot, "worktree", "add", "--detach", referenceTree, REFERENCE_COMMIT]],
    ["cp", ["-a", "--reflink=auto", path.join(repositoryRoot, "node_modules"), path.join(referenceTree, "node_modules")]],
    ["npm", ["run", "build"], { cwd: referenceTree }],
  ];
  for (const [command, args, options] of steps) {
    if (command === "git" && existsSync(referenceTree)) continue;
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
  }
}

async function waitForOwnListener(port, server) {
  const announcement = `listening on ${port}`;
  let output = "";
  const outcome = await Promise.race([
    new Promise((resolve) => server.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(announcement)) resolve("listening");
    })),
    new Promise((resolve) => server.once("exit", (code) => resolve(`exited with ${code}`))),
    sleep(SERVER_START_LIMIT_MS, `did not start within ${SERVER_START_LIMIT_MS} ms`),
  ]);
  if (outcome === "listening") return;
  fail(`the server the tool started on port ${port} ${outcome}; is port ${port} already taken?`);
}

function typescriptNode(script, args) {
  return spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"], cwd: repositoryRoot });
}

async function startSide(kind, port, folder) {
  const sideHome = path.join(folder, kind, "throne-home");
  const cacheHome = path.join(folder, kind, "cache");
  await rm(path.join(folder, kind), { recursive: true, force: true });
  const address = `http://127.0.0.1:${port}`;
  const common = ["--port", String(port), "--data-home", sideHome, "--cache-home", cacheHome];
  let server;
  if (kind === "product") {
    server = typescriptNode(path.join(evidenceFolder, "serve-product.ts"), [...common, "--web-root", productWebRoot]);
  } else {
    const seeded = spawnSync(process.execPath, [path.join(evidenceFolder, "serve-product.ts"), ...common, "--web-root", productWebRoot, "--seed-only", "--markdown-only"], { stdio: "inherit", cwd: repositoryRoot });
    if (seeded.status !== 0) fail("could not seed the reference data home");
    server = spawn(process.execPath, [path.join(evidenceFolder, "serve-reference.mjs"), "--tree", referenceTree, ...common], { stdio: ["ignore", "pipe", "inherit"] });
  }
  startedServers.add(server);
  await waitForOwnListener(port, server);
  return { kind, address, dataHome: sideHome, hasStore: kind === "product", server };
}

async function stopSide(side) {
  if (side.server.exitCode !== null) return;
  side.server.kill("SIGTERM");
  await new Promise((resolve) => side.server.once("exit", resolve));
}

let browser;

async function capture(side, presetName, viewportName, folder) {
  const preset = PRESETS[presetName];
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORTS[viewportName] });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(PINNED_NOW));
  const consoleErrors = [];
  const pageErrors = [];
  const networkRequests = [];
  page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) => networkRequests.push(request.url()));
  const tab = side.kind === "reference" ? (preset.referenceTab ?? preset.tab) : preset.tab;
  await page.goto(`${side.address}/throne/where-i-stand/#${tab}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(SETTLE_MS);
  const action = preset.act ? await preset.act(page, side) : "no action";
  await page.waitForTimeout(SETTLE_MS);
  const file = `${side.kind}-${viewportName}.png`;
  await page.screenshot({ path: path.join(folder, file), fullPage: true });
  await context.close();
  return { file, action, consoleErrors, pageErrors, networkRequests };
}

function contactSheet(entries) {
  const sections = entries
    .map(
      (entry) => `<section><h2>${entry.preset} · ${entry.viewport.width}x${entry.viewport.height}</h2>
<p>product: ${entry.productAction} · reference: ${entry.referenceAction} · <a href="${entry.folder}/evidence.json">evidence.json</a></p>
<div class="pair"><figure><figcaption>Product (this tree)</figcaption><img src="${entry.productCapture}"></figure>
<figure><figcaption>Reference (${REFERENCE_COMMIT})</figcaption><img src="${entry.referenceCapture}"></figure></div>
<ul>${entry.specLines.map((spec) => `<li>${spec.id} ${spec.result}: ${spec.detail}</li>`).join("")}</ul></section>`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>where-i-stand evidence</title>
<style>body{font-family:system-ui;margin:16px;background:#fff;color:#111}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}img{width:100%;border:1px solid #ccc}figcaption{font-weight:600}</style>
</head><body><h1>where-i-stand evidence, pinned clock ${PINNED_NOW}</h1>${sections}</body></html>`;
}

buildReferenceTree();
await mkdir(out, { recursive: true });
const sheetEntries = [];
try {
  for (const presetName of presetNames) {
    for (const viewportName of viewportNames) {
      const folderName = path.join(presetName, viewportName);
      const folder = path.join(out, folderName);
      await mkdir(folder, { recursive: true });
      const startedAt = new Date().toISOString();
      const product = await startSide("product", basePort, dataHome);
      const reference = await startSide("reference", basePort + 1, dataHome);
      try {
        const storeLines = await storeSpecLines(product.address);
        const productShot = await capture(product, presetName, viewportName, folder);
        const referenceShot = await capture(reference, presetName, viewportName, folder);
        const archiveWasOpened = presetName === "archive" || (presetName === "spoiler-open" && productShot.action.startsWith("clicked"));
        const evidence = {
          preset: presetName,
          viewport: VIEWPORTS[viewportName],
          productCapture: path.join(folder, productShot.file),
          referenceCapture: path.join(folder, referenceShot.file),
          consoleErrors: productShot.consoleErrors,
          pageErrors: productShot.pageErrors,
          networkRequests: productShot.networkRequests,
          specLines: [...storeLines, networkSpecLine(productShot.networkRequests, archiveWasOpened)],
          startedAt,
          pinnedClock: PINNED_NOW,
          productAction: productShot.action,
          referenceAction: referenceShot.action,
          referenceConsoleErrors: referenceShot.consoleErrors,
          referencePageErrors: referenceShot.pageErrors,
        };
        await writeFile(path.join(folder, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
        sheetEntries.push({ ...evidence, folder: folderName, productCapture: path.join(folderName, productShot.file), referenceCapture: path.join(folderName, referenceShot.file) });
        console.log(`${presetName} ${viewportName}: ${path.join(folder, "evidence.json")}`);
      } finally {
        await stopSide(product);
        await stopSide(reference);
      }
    }
  }
} finally {
  await browser?.close();
}
await writeFile(path.join(out, "index.html"), contactSheet(sheetEntries));
console.log(`contact sheet: ${path.join(out, "index.html")}`);
if (values["freeze-reference"]) {
  const frozen = path.resolve(values["freeze-reference"]);
  for (const entry of sheetEntries) {
    await mkdir(frozen, { recursive: true });
    await cp(path.join(out, entry.referenceCapture), path.join(frozen, `${entry.preset}-${path.basename(entry.referenceCapture).replace("reference-", "")}`));
  }
  console.log(`reference captures frozen in ${frozen}`);
}
