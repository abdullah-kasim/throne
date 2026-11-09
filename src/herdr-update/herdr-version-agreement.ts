import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { THRONE_HERDR_SESSION_NAME, ownedHerdrClientPath } from '../herdr/herdr-client.ts';
import { RESTART_FAILED_PREFIX } from './herdr-upgrade-restart.ts';

const execFileAsync = promisify(execFile);

const UNREADABLE_VERSION = 'unreadable';
const SERVICE_NOT_RUNNING = 'not running';

export type HerdrVersions = {
  readonly cli: string;
  readonly shim: string;
  readonly service: string;
};

async function versionReportedBy(binary: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version']);
    return stdout.trim().split(/\s+/).at(-1) || UNREADABLE_VERSION;
  } catch {
    return UNREADABLE_VERSION;
  }
}

async function runningServiceVersion(client: string, session: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(client, ['--session', session, 'status', 'server', '--json']);
    const status = JSON.parse(stdout) as { version?: string | null };
    return status.version ?? SERVICE_NOT_RUNNING;
  } catch {
    return UNREADABLE_VERSION;
  }
}

export async function readHerdrVersions(
  shimPath: string,
  clientPath: string = ownedHerdrClientPath(),
  session: string = THRONE_HERDR_SESSION_NAME,
): Promise<HerdrVersions> {
  return {
    cli: await versionReportedBy(clientPath),
    shim: await versionReportedBy(shimPath),
    service: await runningServiceVersion(clientPath, session),
  };
}

function versionsAgree(versions: HerdrVersions): boolean {
  return (
    versions.service !== UNREADABLE_VERSION &&
    versions.cli === versions.service &&
    versions.shim === versions.service
  );
}

export function herdrIsAtPin(versions: HerdrVersions, pinnedTag: string): boolean {
  return versionsAgree(versions) && versions.service === pinnedTag.replace(/^v/, '');
}

export function onlyBinHerdrMissesThePin(versions: HerdrVersions, pinnedTag: string): boolean {
  const pinned = pinnedTag.replace(/^v/, '');
  return versions.cli === pinned && versions.service === pinned && versions.shim !== pinned;
}

export function herdrVersionAgreement(versions: HerdrVersions): string {
  const sideBySide = `throne cli herdr ${versions.cli}, bin/herdr ${versions.shim}, running service ${versions.service}`;
  return versionsAgree(versions)
    ? sideBySide
    : `${RESTART_FAILED_PREFIX} the herdr versions differ: ${sideBySide}`;
}
