import { realSemaphoreDependencies, runSemaphore } from "./semaphore-runtime.ts";
import { SHORT_RETRY_MILLISECONDS } from "./semaphore.test-support.ts";

const [throneHome = "", ...runArguments] = process.argv.slice(2);

process.exitCode = await runSemaphore(["run", ...runArguments], {
  ...realSemaphoreDependencies({ THRONE_DATA_HOME: throneHome }),
  retryMilliseconds: SHORT_RETRY_MILLISECONDS,
});
