import { spawn } from "node:child_process";

const [owned, ready] = process.argv.slice(2);
spawn(
  process.execPath,
  [
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(owned)}, 'leaked'), 350)`,
  ],
  { stdio: "ignore" },
);
setInterval(() => {}, 1_000);
