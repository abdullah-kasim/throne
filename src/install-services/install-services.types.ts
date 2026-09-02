import type {
  HerdrInstallResult,
  InstallHerdrOptions,
} from './herdr-release.service.ts';
import type {
  ServiceCommandResult,
  ServiceUnitDeps,
} from '../install-services/service-unit-renderer.service.ts';

export type InstallServicesStatus =
  | 'installed'
  | 'unchanged'
  | 'dry-run'
  | 'skipped-no-systemd'
  | 'error-no-launchctl'
  | 'unsupported-platform'
  | 'error';

export interface InstallServicesResult {
  code: number;
  status: InstallServicesStatus;
  changedWhileRunning: string[];
}

export interface InstallServicesOptions {
  dryRun: boolean;
  throneRoot: string;
  /** True only when the caller passed `--throne-root` explicitly — the
   *  deliberate opt-out from the worktree-refusal guard (see
   *  `installServices` in `install-services.ts`). False for the default
   *  (compiled-module-derived) root, which must be the live main checkout. */
  throneRootExplicit: boolean;
  offline?: boolean;
}

export interface InstallServicesDeps extends ServiceUnitDeps {
  platform: NodeJS.Platform;
  ownedHerdrPath(): string;
  herdrCacheDirectory(): string;
  /** The resolved mise `lts` node interpreter path, or null if it can't be located. */
  resolveNodeBin(): string | null;
  installHerdr(options: InstallHerdrOptions): Promise<HerdrInstallResult>;
  arch: string;
  launchctl(args: string[]): Promise<ServiceCommandResult>;
  userId(): number;
  throneCommandPath(): string;
  inspectThroneCommand(
    targetPath: string,
  ): Promise<{ kind: 'missing' | 'file' | 'symlink'; target?: string }>;
  createThroneCommandSymlink(
    sourcePath: string,
    targetPath: string,
  ): Promise<void>;
  herdrDecoupleEnabled(): boolean;
  pathSymlinkTargets(): string[];
  inspectPathSymlink(
    targetPath: string,
  ): Promise<{ kind: 'missing' | 'file' | 'symlink'; target?: string }>;
  writePathSymlink(sourcePath: string, targetPath: string): Promise<void>;
  /**
   * Removes an installed unit file, if present. Used only by retirement of a
   * unit `install-services` no longer manages (see `retireLinuxUnit` in
   * `linux.ts`, the `throne-build.service` collapse into `throne-backend`) —
   * never by ordinary render/install, which always overwrites in place
   * through `writeUnitFile` instead.
   */
  removeUnitFile(targetPath: string): Promise<void>;
}
