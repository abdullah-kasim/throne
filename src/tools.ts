import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

export function selfInvocationUrl(argv1: string): string | undefined {
  // import.meta.url below resolves through symlinks (Node's ESM loader
  // realpath's the module it loads), but process.argv[1] is whatever path
  // the caller literally invoked -- e.g. dist/src/tools.js when dist is the
  // atomic-publish symlink (see scripts/build-and-publish-dist.mjs) rather
  // than the dist.build.<gen>/src/tools.js it resolves to. Realpath argv[1]
  // too so this guard still matches through the symlink; a missing target
  // (a torn/removed tree mid-swap) falls through to "not the entrypoint"
  // rather than throwing.
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return undefined;
  }
}

export const BUILD_SKEW_ERROR_CODE = "THRONE_BUILD_SKEW";
export const MODULE_LOAD_FAILURE_EXIT_CODE = 2;

function sourceEntrypointWasInvoked(argv1: string | undefined): boolean {
  return (
    argv1 !== undefined &&
    selfInvocationUrl(argv1) === import.meta.url &&
    fileURLToPath(import.meta.url).endsWith("/src/tools.ts")
  );
}

export interface EntrypointDependencies {
  loadApplicationModule: () => Promise<
    Pick<typeof import("./application.ts"), "executeCommand">
  >;
  writeStderr: (text: string) => void;
}

const productionDependencies: EntrypointDependencies = {
  loadApplicationModule: () => import("./application.ts"),
  writeStderr: (text) => process.stderr.write(text),
};

export async function runEntrypoint(
  dependencies: EntrypointDependencies = productionDependencies,
): Promise<number> {
  let applicationModule: Pick<
    typeof import("./application.ts"),
    "executeCommand"
  >;
  try {
    applicationModule = await dependencies.loadApplicationModule();
  } catch (moduleLoadError) {
    const sourceEntrypoint = sourceEntrypointWasInvoked(process.argv[1]);
    dependencies.writeStderr(
      `${JSON.stringify({
        error: BUILD_SKEW_ERROR_CODE,
        retryable: !sourceEntrypoint,
        message: sourceEntrypoint
          ? "Source entrypoint invocation is unsupported; invoke dist/src/tools.js instead."
          : moduleLoadError instanceof Error
            ? moduleLoadError.message
            : String(moduleLoadError),
      })}\n`,
    );
    return MODULE_LOAD_FAILURE_EXIT_CODE;
  }

  return applicationModule.executeCommand(process.argv).then(
    (code) => code,
    (err: unknown) => {
      dependencies.writeStderr(
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    },
  );
}

if (
  process.argv[1] !== undefined &&
  selfInvocationUrl(process.argv[1]) === import.meta.url
) {
  runEntrypoint().then((code) => {
    process.exitCode = code;
  });
}
