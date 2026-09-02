import { stat } from 'node:fs/promises';

export async function assertCompiledFixtureRunnerExists(runnerPath: string): Promise<void> {
  const runnerExists = await stat(runnerPath).then(
    () => true,
    () => false,
  );
  if (!runnerExists) {
    throw new Error(
      `Compiled fixture runner missing at ${runnerPath}. ` +
        'This test spawns real child processes against the compiled dist/ output, ' +
        'not the TypeScript source. Run `npm run build` to compile it, then re-run this test.',
    );
  }
}
