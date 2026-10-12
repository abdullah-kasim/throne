import semver from "semver";

export interface NodeReleaseCandidates {
  installedVersions(): Promise<readonly string[]>;
  availableVersions(): Promise<readonly string[]>;
  newestLtsVersion(): Promise<string>;
}

export interface NodeReleaseChoice {
  readonly version: string;
  readonly isLts: boolean;
}

export function isExactNodeVersion(declared: string): boolean {
  return semver.valid(declared) !== null;
}

export function isNodeVersionRange(declared: string): boolean {
  return semver.validRange(declared) !== null;
}

export function isLtsRelease(
  version: string,
  newestLtsVersion: string,
): boolean {
  const major = semver.major(version);
  return major % 2 === 0 && major <= semver.major(newestLtsVersion);
}

function newestReleaseSatisfying(
  constraint: string,
  versions: readonly string[],
): string | null {
  return semver.maxSatisfying([...versions], constraint);
}

export async function chooseNodeRelease(
  constraint: string,
  candidates: NodeReleaseCandidates,
): Promise<NodeReleaseChoice | null> {
  const newestLts = await candidates.newestLtsVersion();
  const isLts = (version: string) => isLtsRelease(version, newestLts);
  const installed = await candidates.installedVersions();
  const installedLts = newestReleaseSatisfying(
    constraint,
    installed.filter(isLts),
  );
  if (installedLts !== null) return { version: installedLts, isLts: true };
  const available = await candidates.availableVersions();
  const availableLts = newestReleaseSatisfying(
    constraint,
    available.filter(isLts),
  );
  if (availableLts !== null) return { version: availableLts, isLts: true };
  const newestAny =
    newestReleaseSatisfying(constraint, installed) ??
    newestReleaseSatisfying(constraint, available);
  return newestAny === null ? null : { version: newestAny, isLts: false };
}
