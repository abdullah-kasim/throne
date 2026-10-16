import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SUITE_IMAGE_REPOSITORY_ROOT,
  createHostDistMountArguments,
  runHostPreGuardsWhileImageBuilds,
} from "./suite-host-pre-guards.mjs";

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the suite image reuses the host's build instead of building again", () => {
  const dockerfile = readFileSync(path.join(repositoryRoot, "docker", "suite-app.Dockerfile"), "utf8");
  const testIsolated = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).scripts["test:isolated"];

  assert.doesNotMatch(dockerfile, /npm run build/);
  assert.match(dockerfile, new RegExp(`^WORKDIR ${SUITE_IMAGE_REPOSITORY_ROOT}$`, "m"));
  assert.deepEqual(createHostDistMountArguments("/home/runner/throne/dist.build.123"), [
    "--volume",
    "/home/runner/throne/dist.build.123:/throne/dist:ro",
  ]);
  assert.doesNotMatch(testIsolated, /npm run build/);
});

test("the pre-guards that do not need the suite session run while the image builds", async () => {
  const events: string[] = [];
  let finishImageBuild = () => {};
  const imageBuildFinished = new Promise<void>((resolve) => {
    finishImageBuild = resolve;
  });
  let clockMs = 0;

  const timings = runHostPreGuardsWhileImageBuilds(
    () => {
      events.push("image build started");
      return imageBuildFinished.then(() => events.push("image build finished"));
    },
    () => {
      events.push("host guard ran");
      clockMs += 5;
      return { ok: true };
    },
    () => clockMs,
  );
  events.push("waiting for the image");
  clockMs = 100;
  finishImageBuild();
  const { imageBuild, hostGuards } = await timings;

  assert.deepEqual(events, ["image build started", "host guard ran", "waiting for the image", "image build finished"]);
  assert.deepEqual(hostGuards, { startedAtMs: 0, finishedAtMs: 5, result: { ok: true } });
  assert.deepEqual(imageBuild, { startedAtMs: 0, finishedAtMs: 100 });
  const testIsolated = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).scripts["test:isolated"];
  assert.doesNotMatch(testIsolated, /dist-staleness-guard/);
  assert.match(testIsolated, /--pre-guard node --import \.\/test\/register-typescript\.mjs scripts\/herdr-tab-leak-guard\.mjs pretest/);
});
