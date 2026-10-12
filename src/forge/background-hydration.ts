import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHydrationPlan } from "../git-lifecycle/dependency-hydration.ts";
import { manifestFingerprint, readHydrationMarker } from "../git-lifecycle/dependency-hydration-fingerprint.ts";
import { pathExists } from "../git-lifecycle/dependency-hydration-install.ts";

export type BackgroundHydration =
  | { readonly outcome: "already current" }
  | { readonly outcome: "started"; readonly logPath: string };

const HYDRATION_RUNNER_PATH = fileURLToPath(
  new URL(`./background-hydration-runner${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

export function hydrationLogPath(worktree: string): string {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "throne", "forge-open", `${path.basename(worktree)}.log`);
}

export async function dependenciesAreCurrent(worktree: string): Promise<boolean> {
  const plan = await buildHydrationPlan(worktree);
  const fingerprint = await manifestFingerprint(worktree);
  for (const relativePath of plan.paths) {
    const dependencyPath = path.join(worktree, relativePath);
    if (!(await pathExists(dependencyPath))) return false;
    const marker = await readHydrationMarker(dependencyPath);
    if (marker !== undefined && marker.fingerprint !== fingerprint) return false;
  }
  return true;
}

export async function startBackgroundHydration(sourceCheckout: string, worktree: string): Promise<BackgroundHydration> {
  if (await dependenciesAreCurrent(worktree)) return { outcome: "already current" };
  const logPath = hydrationLogPath(worktree);
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, "w");
  try {
    spawn(process.execPath, [...process.execArgv, HYDRATION_RUNNER_PATH, sourceCheckout, worktree], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    }).unref();
  } finally {
    await log.close();
  }
  return { outcome: "started", logPath };
}

