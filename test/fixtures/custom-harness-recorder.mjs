import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [mode, recordPath, ...tokens] = process.argv.slice(2);
await writeFile(recordPath, JSON.stringify({ argv: tokens, cwd: process.cwd(), environment: process.env }));
process.stdout.write('fixture stdout\n');
process.stderr.write('fixture stderr\n');
if (mode === 'nonzero') process.exit(23);
if (mode === 'timeout') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' });
  await writeFile(`${recordPath}.pid`, `${grandchild.pid}\n`);
  setInterval(() => {}, 1000);
}
