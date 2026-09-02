import { appendFile, rm } from "node:fs/promises";
import process from "node:process";
import { createCleanupStack } from "../../scripts/run-suite-container.mjs";
import {
  findSuiteSignal,
  runChildWithSignalForwarding,
} from "../../scripts/suite-child-signal-forwarding.mjs";

const [ownedPath, logPath] = process.argv.slice(2);
const cleanup = createCleanupStack();
cleanup.register("owned fixture", async () => {
  await appendFile(logPath, "cleanup\n");
  await rm(ownedPath, { force: true });
});

let primaryFailure;
try {
  await runChildWithSignalForwarding(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs'); process.on('SIGINT',()=>{fs.appendFileSync(process.argv[1],'child:SIGINT\\n');process.exit(0)}); process.on('SIGTERM',()=>{fs.appendFileSync(process.argv[1],'child:SIGTERM\\n');process.exit(0)}); process.stdout.write('READY\\n'); setInterval(()=>{},1000)`,
      logPath,
    ],
    { stdio: "inherit" },
  );
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    await cleanup.run(primaryFailure);
  } catch (error) {
    const signal = findSuiteSignal(error);
    if (signal) process.kill(process.pid, signal);
    throw error;
  }
}
