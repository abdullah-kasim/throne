import {
  DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES,
  HerdrClientService,
  resolveHerdrReadOnlyInvocation,
  type HerdrReadOnlyClientDependencies,
} from './herdr-client.ts';

export type HerdrSessionPresenceDependencies = HerdrReadOnlyClientDependencies;

export async function isInsideHerdrSession(
  dependencies: HerdrSessionPresenceDependencies =
    DEFAULT_HERDR_READ_ONLY_CLIENT_DEPENDENCIES,
): Promise<boolean> {
  try {
    const invocation = resolveHerdrReadOnlyInvocation(
      ['pane', 'current'],
      dependencies.isHerdrDecoupleEnabled(),
      dependencies.ownedHerdrClientPath,
    );
    await dependencies.executeHerdrReadOnly(
      invocation.executablePath,
      invocation.args,
    );
    return true;
  } catch {
    return false;
  }
}

export async function isInsideHerdrSessionWithClient(
  client: HerdrClientService = new HerdrClientService(),
): Promise<boolean> {
  try {
    await client.execute(['pane', 'current']);
    return true;
  } catch {
    return false;
  }
}
