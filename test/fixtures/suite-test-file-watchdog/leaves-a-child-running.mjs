import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import test from "node:test";

test("starts a child process and leaves it running", () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.LEFT_RUNNING_CHILD_PID_FILE, String(child.pid));
});
