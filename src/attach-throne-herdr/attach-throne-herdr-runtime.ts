import {
  HerdrClientService,
  THRONE_HERDR_SESSION_NAME,
} from '../herdr/herdr-client.ts';
import { ownedHerdrExecutablePath } from '../install-services/herdr-release.service.ts';
import { FEATURE_FLAGS, featureFlagsPath } from '../shared-policy/feature-flags.service.ts';

function help(): string {
  const enabled = FEATURE_FLAGS['herdr-decouple'];
  return [
    `throne — attach to the throne-managed herdr session "${THRONE_HERDR_SESSION_NAME}"`,
    '',
    'Usage: throne [herdr attach options]',
    '',
    `Feature flag "herdr-decouple": ${enabled ? 'ON' : 'OFF'} (${featureFlagsPath()})`,
    'Valid file: strict JSON object {"herdr-decouple": true|false}; absent defaults OFF.',
    'Changing the flag never touches or restarts a live server; service handoff is separate.',
    enabled
      ? `Owned client: ${ownedHerdrExecutablePath()}`
      : 'Attach status: disabled; OFF uses legacy PATH herdr and its implicit/default session',
    enabled
      ? `Target: named herdr session "${THRONE_HERDR_SESSION_NAME}" (never the default session)`
      : 'Runtime target: legacy PATH herdr with its implicit/default session',
    '',
  ].join('\n');
}

export async function run(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(help());
    return 0;
  }
  try {
    return await new HerdrClientService().attach(args);
  } catch (error) {
    const recovery = FEATURE_FLAGS['herdr-decouple']
      ? 'run install-services to restore the pinned client, then activate the throne herdr service'
      : `enable "herdr-decouple" in ${featureFlagsPath()} before using throne`;
    process.stderr.write(
      `throne: cannot attach to throne-managed herdr session "${THRONE_HERDR_SESSION_NAME}": ` +
        `${error instanceof Error ? error.message : String(error)}; ` +
        `${recovery}\n`,
    );
    return 1;
  }
}
