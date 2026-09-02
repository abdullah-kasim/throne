import { access } from "node:fs/promises";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { resolveLiveThroneRoot } from "../throne-root-resolution.ts";
import { userConfigPath } from "../user-config-loader.ts";

export interface RoutingQueryAuthorityDependencies {
  readonly runtimeRoot: string;
  readonly hasUserConfig: (root: string) => Promise<boolean>;
  readonly resolveLiveRoot: (root: string) => Promise<string>;
}

const PRODUCTION_DEPENDENCIES: RoutingQueryAuthorityDependencies = {
  runtimeRoot: RUNTIME_THRONE_ROOT,
  hasUserConfig: async (root) => {
    try {
      await access(userConfigPath(root));
      return true;
    } catch {
      return false;
    }
  },
  resolveLiveRoot: resolveLiveThroneRoot,
};

/** Refuses a routing query that would silently substitute checkout defaults
 * for the live court's machine-local policy. */
export async function assertAuthoritativeRoutingQuery(
  dependencies: RoutingQueryAuthorityDependencies = PRODUCTION_DEPENDENCIES,
): Promise<void> {
  const { runtimeRoot } = dependencies;
  if (await dependencies.hasUserConfig(runtimeRoot)) {
    return;
  }

  const liveRoot = await dependencies.resolveLiveRoot(runtimeRoot);
  throw new Error(
    `Refusing to answer a plan/routing question from checkout "${runtimeRoot}": ` +
      "this checkout has no config.user.ts, so its committed defaults are not " +
      `authoritative for the live court. Query the live court with ` +
      `throne-cli list-harnesses-and-models --json (live root: "${liveRoot}").`,
  );
}
