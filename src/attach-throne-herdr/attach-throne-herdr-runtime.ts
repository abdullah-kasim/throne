import {
  HerdrClientService,
  THRONE_HERDR_SESSION_NAME,
} from '../herdr/herdr-client.ts';
import { ownedHerdrExecutablePath } from '../install-services/herdr-release.service.ts';

function help(): string {
  return [
    `throne — attach to the throne-managed herdr session "${THRONE_HERDR_SESSION_NAME}"`,
    '',
    'Usage: throne [herdr attach options]',
    '',
    `Owned client: ${ownedHerdrExecutablePath()}`,
    `Target: named herdr session "${THRONE_HERDR_SESSION_NAME}" (never the default session)`,
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
    process.stderr.write(
      `throne: cannot attach to throne-managed herdr session "${THRONE_HERDR_SESSION_NAME}": ` +
        `${error instanceof Error ? error.message : String(error)}; ` +
        'run install-services to restore the pinned client, then activate the throne herdr service\n',
    );
    return 1;
  }
}
