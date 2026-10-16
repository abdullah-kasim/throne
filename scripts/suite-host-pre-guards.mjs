import { realpathSync } from "node:fs";
import path from "node:path";
import { checkDistIsFresh } from "./dist-staleness-guard.mjs";

export const SUITE_IMAGE_REPOSITORY_ROOT = "/throne";

export function checkHostDistIsFresh(repositoryRoot) {
  const distLink = path.join(repositoryRoot, "dist");
  const result = checkDistIsFresh(repositoryRoot, distLink);
  return result.ok ? { ...result, distDirectory: realpathSync(distLink) } : result;
}

export function createHostDistMountArguments(distDirectory) {
  return ["--volume", `${distDirectory}:${path.posix.join(SUITE_IMAGE_REPOSITORY_ROOT, "dist")}:ro`];
}

export async function runHostPreGuardsWhileImageBuilds(buildImage, runHostPreGuards, now = Date.now) {
  const imageBuild = { startedAtMs: now() };
  const imageBuilt = buildImage().finally(() => {
    imageBuild.finishedAtMs = now();
  });
  const hostGuards = { startedAtMs: now() };
  hostGuards.result = runHostPreGuards();
  hostGuards.finishedAtMs = now();
  await imageBuilt;
  return { imageBuild, hostGuards };
}
