import { execFile } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { ownedHerdrClientPath } from "./herdr-client.ts";

const runFile = promisify(execFile);

export const PI_STATE_EXTENSION_NAME = "throne-pi-state.ts";
export const PI_HOOKS_EXTENSION_NAME = "throne-pi-hooks.ts";
export const HERDR_PI_INTEGRATION_NAME = "herdr-agent-state.ts";
export const PI_STATE_EXTENSION_SOURCE = path.join(
  RUNTIME_THRONE_ROOT,
  "extensions",
  "pi",
  PI_STATE_EXTENSION_NAME,
);

export interface PiStateInstall {
  readonly throneExtension: string;
  readonly hooksExtension: string;
  readonly herdrIntegration: string;
}

export async function installPiStateExtensions(
  agentDirectory: string,
  herdrExecutable: string = ownedHerdrClientPath(),
): Promise<PiStateInstall> {
  const extensions = path.join(agentDirectory, "extensions");
  await mkdir(extensions, { recursive: true });
  const throneExtension = path.join(extensions, PI_STATE_EXTENSION_NAME);
  await rm(throneExtension, { force: true });
  await symlink(PI_STATE_EXTENSION_SOURCE, throneExtension);
  const hooksExtension = path.join(extensions, PI_HOOKS_EXTENSION_NAME);
  await rm(hooksExtension, { force: true });
  await symlink(path.join(path.dirname(PI_STATE_EXTENSION_SOURCE), PI_HOOKS_EXTENSION_NAME), hooksExtension);
  try {
    await runFile(herdrExecutable, ["integration", "install", "pi"], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
      timeout: 30_000,
    });
  } catch (error) {
    const said = (error as { stderr?: string }).stderr?.trim() || String(error);
    throw new Error(`herdr's pi integration did not install into ${extensions}: ${said}`);
  }
  return { throneExtension, hooksExtension, herdrIntegration: path.join(extensions, HERDR_PI_INTEGRATION_NAME) };
}
