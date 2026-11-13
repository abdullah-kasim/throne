import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { callerSearchPath, checkJscpd, renderJscpdCheck } from "./check-jscpd.ts";

const PINNED = "5.4.3";

async function writeExecutable(file: string, versionLine: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\necho '${versionLine}'\n`);
  await chmod(file, 0o755);
}

async function fakeThroneRoot(vendoredVersionLine: string | undefined): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "check-jscpd-"));
  await writeFile(
    path.join(root, "vendor-pins.json"),
    JSON.stringify({ harnesses: { jscpd: { package: "jscpd", version: PINNED } } }),
  );
  await writeExecutable(path.join(root, "bin", "jscpd"), "shim");
  if (vendoredVersionLine !== undefined) {
    await writeExecutable(path.join(root, "vendor", "node_modules", ".bin", "jscpd"), vendoredVersionLine);
  }
  return root;
}

test("the jscpd check passes when the vendored jscpd is the pinned version and PATH reaches the shim", async () => {
  const root = await fakeThroneRoot(`jscpd ${PINNED}`);
  const check = await checkJscpd(root, path.join(root, "bin"));
  assert.equal(check.matches, true);
  assert.equal(check.vendored, PINNED);
  assert.equal(check.onPath, path.join(root, "bin", "jscpd"));
  assert.doesNotMatch(renderJscpdCheck(check), /install\.sh/);
});

test("the jscpd check fails and names the installer step when the vendored jscpd is older", async () => {
  const root = await fakeThroneRoot("cpd 5.0.14");
  const check = await checkJscpd(root, path.join(root, "bin"));
  assert.equal(check.matches, false);
  assert.equal(check.vendored, "5.0.14");
  assert.match(renderJscpdCheck(check), /not the pinned 5\.4\.3; run \.\/install\.sh --harnesses-only/);
});

test("the jscpd check fails and names the installer step when the vendored jscpd is missing", async () => {
  const root = await fakeThroneRoot(undefined);
  const check = await checkJscpd(root, path.join(root, "bin"));
  assert.equal(check.matches, false);
  const output = renderJscpdCheck(check);
  assert.match(output, /vendored: missing/);
  assert.match(output, /install\.sh --harnesses-only/);
});

test("the jscpd check fails when the vendored jscpd version line cannot be read", async () => {
  const root = await fakeThroneRoot("version unknown");
  const check = await checkJscpd(root, path.join(root, "bin"));
  assert.equal(check.matches, false);
  assert.match(renderJscpdCheck(check), /vendored: unreadable version/);
});

test("the jscpd check fails and names the path of a different jscpd earlier on PATH", async () => {
  const root = await fakeThroneRoot(`jscpd ${PINNED}`);
  const foreign = path.join(root, "elsewhere", "jscpd");
  await writeExecutable(foreign, `jscpd ${PINNED}`);
  const check = await checkJscpd(root, [path.dirname(foreign), path.join(root, "bin")].join(path.delimiter));
  assert.equal(check.matches, false);
  assert.equal(check.onPath, foreign);
  assert.match(renderJscpdCheck(check), new RegExp(`a different jscpd comes first on PATH: ${foreign}`));
});

test("the jscpd check passes when PATH reaches the shim through a symlinked spelling of the throne root", async () => {
  const root = await fakeThroneRoot(`jscpd ${PINNED}`);
  const aliasParent = await mkdtemp(path.join(tmpdir(), "check-jscpd-alias-"));
  const alias = path.join(aliasParent, "throne");
  await symlink(root, alias);
  const check = await checkJscpd(root, path.join(alias, "bin"));
  assert.equal(check.matches, true);
});

test("the jscpd check looks past the node directory the throne launcher puts first on PATH", () => {
  const searchPath = ["/node/bin", "/throne/bin", "/node/bin"].join(path.delimiter);
  assert.equal(callerSearchPath(searchPath, "/node/bin"), ["/throne/bin", "/node/bin"].join(path.delimiter));
  assert.equal(callerSearchPath(searchPath, "/other/bin"), searchPath);
});

test("the jscpd check matches the launcher's node directory through a symlinked spelling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "check-jscpd-node-"));
  const nodeDirectory = path.join(root, "node", "bin");
  await mkdir(nodeDirectory, { recursive: true });
  await symlink(path.join(root, "node"), path.join(root, "linked-node"));
  const searchPath = [path.join(root, "linked-node", "bin"), "/throne/bin"].join(path.delimiter);
  assert.equal(callerSearchPath(searchPath, nodeDirectory), "/throne/bin");
});
