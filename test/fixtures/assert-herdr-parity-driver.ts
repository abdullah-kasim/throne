import {
  BUILD_SKEW_ERROR_CODE,
  MODULE_LOAD_FAILURE_EXIT_CODE,
} from '../../src/tools.ts';

const route = process.argv[2];
const commandArgs = process.argv.slice(3);

if (route !== 'nest') {
  throw new Error(`Unknown assert-herdr parity route: ${String(route)}`);
}

async function run(): Promise<void> {
  let applicationModule: Pick<
    typeof import('../../src/application.ts'),
    'runNestCommanderApplication'
  >;
  try {
    applicationModule = await import('../../src/application.ts');
  } catch (moduleLoadError) {
    process.stderr.write(
      `${JSON.stringify({
        error: BUILD_SKEW_ERROR_CODE,
        retryable: true,
        message:
          moduleLoadError instanceof Error
            ? moduleLoadError.message
            : String(moduleLoadError),
      })}\n`,
    );
    process.exitCode = MODULE_LOAD_FAILURE_EXIT_CODE;
    return;
  }

  await applicationModule
    .runNestCommanderApplication([
      process.execPath,
      'src/tools.ts',
      'assert-herdr',
      ...commandArgs,
    ])
    .then(
      (status) => {
        process.exitCode = status;
      },
      (error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
}

await run();
