import os from "node:os";
import path from "node:path";

/**
 * The only authority for mutable throne state.  The override is deliberately
 * narrow: tests may provide an absolute isolated home, while production
 * defaults to the user's durable home regardless of the checkout or cwd.
 */
export const RUNTIME_DATA_HOME_ENV = "THRONE_DATA_HOME";

export function resolveRuntimeDataHome(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = os.homedir(),
): string {
  const configured = environment[RUNTIME_DATA_HOME_ENV]?.trim();
  const home = configured || path.join(userHome, ".throne");
  if (!path.isAbsolute(home)) {
    throw new Error(`${RUNTIME_DATA_HOME_ENV} must be an absolute path`);
  }
  return path.resolve(home);
}

export const RUNTIME_DATA_HOME = resolveRuntimeDataHome();
export const RUNTIME_DATA_DIR = path.join(RUNTIME_DATA_HOME, "data");
