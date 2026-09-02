import { selectHerdrTarget } from './herdr-release.service.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import { writeInstallServicesLine } from './output.ts';

export async function prepareOwnedHerdr(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<string> {
  const installPath = deps.ownedHerdrPath();
  const target = selectHerdrTarget(deps.platform, deps.arch);
  if (options.dryRun) {
    writeInstallServicesLine(
      `would verify/install pinned herdr for ${target} → ${installPath}` +
        (options.offline === true ? ' (offline)' : ''),
    );
    return installPath;
  }
  const result = await deps.installHerdr({
    cacheDir: deps.herdrCacheDirectory(),
    installPath,
    offline: options.offline,
    platform: deps.platform,
    arch: deps.arch,
  });
  writeInstallServicesLine(
    `verified pinned herdr from ${result.source} → ${result.installPath}`,
  );
  return result.installPath;
}
