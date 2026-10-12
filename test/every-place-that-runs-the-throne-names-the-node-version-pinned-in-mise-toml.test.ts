import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REAL_DEPS } from "../src/install-services/platform.ts";
import {
  renderUnitSource,
  SYSTEMD_SOURCE_DIR,
  SYSTEMD_UNIT_NAMES,
} from "../src/install-services/service-unit-renderer.service.ts";
import { provisionPinnedNode, readPinnedNodeVersion } from "./pinned-node.support.ts";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE_NODE_TAG = /^FROM docker\.io\/library\/node:(\S+)-bookworm$/m;

let scratch: string;
let throneRoot: string;
let home: string;
let homeBeforeTests: string | undefined;
let pinnedVersion: string;

function disagreement(site: string, siteVersion: string | undefined): string {
  return `${site} names node ${siteVersion ?? "(none)"}, but mise.toml pins ${pinnedVersion}`;
}

function versionOfMiseNodeInstall(nodeBinDirectory: string): string {
  return path.basename(path.dirname(nodeBinDirectory));
}

before(async () => {
  homeBeforeTests = process.env.HOME;
  pinnedVersion = await readPinnedNodeVersion();
  scratch = await mkdtemp(path.join(tmpdir(), "node-pin-agreement-"));
  throneRoot = path.join(scratch, "throne");
  home = path.join(scratch, "home");
  await provisionPinnedNode(throneRoot, home);
  await copyFile(path.join(REPO_ROOT, "bin", "throne"), path.join(throneRoot, "bin", "throne"));
  await mkdir(path.join(throneRoot, "dist", "src"), { recursive: true });
  await writeFile(
    path.join(throneRoot, "dist", "src", "tools.js"),
    'console.log(process.env.PATH.split(":")[0]);\n',
  );
});

after(async () => {
  process.env.HOME = homeBeforeTests;
  await rm(scratch, { recursive: true, force: true });
});

test("the test suite container is built on the node version pinned in mise.toml", async () => {
  const dockerfile = await readFile(path.join(REPO_ROOT, "docker", "suite-app.Dockerfile"), "utf8");
  const tagVersion = DOCKERFILE_NODE_TAG.exec(dockerfile)?.[1];

  assert.equal(tagVersion, pinnedVersion, disagreement("docker/suite-app.Dockerfile FROM", tagVersion));
});

test("package.json engines names the node version pinned in mise.toml", async () => {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const enginesVersion = packageJson.engines?.node;

  assert.equal(enginesVersion, pinnedVersion, disagreement("package.json engines.node", enginesVersion));
});

test("the throne launcher runs the node version pinned in mise.toml", async () => {
  const { stdout } = await run(path.join(throneRoot, "bin", "throne"), ["agent-statuses"], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  const launcherVersion = versionOfMiseNodeInstall(stdout.trim());

  assert.equal(launcherVersion, pinnedVersion, disagreement("bin/throne", launcherVersion));
});

test("the services resolve the node version pinned in mise.toml", () => {
  process.env.HOME = home;
  const nodeBin = REAL_DEPS.resolveNodeBin(REPO_ROOT);
  const servicesVersion = nodeBin === null ? undefined : versionOfMiseNodeInstall(path.dirname(nodeBin));

  assert.equal(servicesVersion, pinnedVersion, disagreement("realResolveNodeBin", servicesVersion));
});

test("the throne backend app runs the node version pinned in mise.toml", async () => {
  process.env.HOME = home;
  const unitSource = await readFile(path.join(SYSTEMD_SOURCE_DIR, SYSTEMD_UNIT_NAMES.THRONE_BACKEND), "utf8");
  const rendered = renderUnitSource(unitSource, {
    throneRoot: REPO_ROOT,
    herdrBin: null,
    nodeBin: REAL_DEPS.resolveNodeBin(REPO_ROOT),
  });
  const appNodeBin = /nest\.js start .*--exec (\S+)/.exec(rendered)?.[1];
  const appVersion = appNodeBin === undefined ? undefined : versionOfMiseNodeInstall(path.dirname(appNodeBin));

  assert.equal(appVersion, pinnedVersion, disagreement("throne-backend.service app --exec", appVersion));
});
