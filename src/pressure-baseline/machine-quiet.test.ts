import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { UNKNOWN_PSI_READING, type PsiReading } from "../pressure-signal/psi-pressure-reader.ts";
import { judgeQuiet, readMachineQuiet } from "./machine-quiet.ts";

let scratchRoot: string;

function stall(percent: number): PsiReading {
  return { state: "ok", avg10: percent, avg60: percent };
}

function psiFile(avg60: number): string {
  return `some avg10=0.00 avg60=${avg60.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`;
}

before(async () => {
  scratchRoot = await mkdtemp(path.join(os.tmpdir(), "machine-quiet-"));
});

after(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

test("the machine is quiet only when cpu and io stall are under 5 and memory stall under 1", () => {
  assert.deepEqual(judgeQuiet({ cpu: stall(4.9), disk: stall(4.9), memory: stall(0.9) }), { quiet: true });
  assert.deepEqual(judgeQuiet({ cpu: stall(5), disk: stall(0), memory: stall(0) }), {
    quiet: false,
    reason: "cpu stall 5% — the machine is not quiet",
  });
  assert.deepEqual(judgeQuiet({ cpu: stall(0), disk: stall(60), memory: stall(1) }), {
    quiet: false,
    reason: "disk busy 60%, memory stall 1% — the machine is not quiet",
  });
});

test("an unreadable pressure figure means the machine is not quiet", () => {
  assert.deepEqual(judgeQuiet({ cpu: stall(0), disk: stall(0), memory: UNKNOWN_PSI_READING }), {
    quiet: false,
    reason: "memory pressure unreadable — the machine is not quiet",
  });
});

test("on Linux quiet is judged from the cpu and memory pressure files and the busiest disk", async () => {
  const cpuPath = path.join(scratchRoot, "cpu");
  const memoryPath = path.join(scratchRoot, "memory");
  const diskstatsPath = path.join(scratchRoot, "diskstats");
  const sysBlockRoot = path.join(scratchRoot, "block");
  await mkdir(path.join(sysBlockRoot, "sda", "device"), { recursive: true });
  await writeFile(diskstatsPath, "   8       0 sda 1 0 0 0 0 0 0 0 0 500 0 0 0\n");
  await writeFile(memoryPath, psiFile(0));
  const disk = {
    diskstatsPath,
    sysBlockRoot,
    homePath: scratchRoot,
    mountinfoPath: path.join(scratchRoot, "no-mountinfo"),
    sysFsBtrfsRoot: path.join(scratchRoot, "no-btrfs"),
    sleep: () => {},
    now: () => 1000,
  };

  await writeFile(cpuPath, psiFile(0.5));
  assert.deepEqual(readMachineQuiet({ platform: "linux", cpuPath, memoryPath, disk }), {
    quiet: false,
    reason: "disk pressure unreadable — the machine is not quiet",
  });

  let clock = 0;
  const ticking = { ...disk, now: () => (clock += 1000) };
  assert.deepEqual(readMachineQuiet({ platform: "linux", cpuPath, memoryPath, disk: ticking }), { quiet: true });

  await writeFile(cpuPath, psiFile(12.3));
  assert.deepEqual(readMachineQuiet({ platform: "linux", cpuPath, memoryPath, disk: ticking }), {
    quiet: false,
    reason: "cpu stall 12.3% — the machine is not quiet",
  });
});

test("on macOS quiet is judged from the darwin readers' figures under the same numbers", () => {
  const idleIostat = "      cpu    load average\n us sy id   1m   5m   15m\n  9  4 87  1.74 2.21 2.56\n  1  0 99  2.00 2.25 2.58\n";
  const darwin = (memorySysctl: string) => {
    return {
      platform: "darwin" as const,
      readDarwinIostat: () => idleIostat,
      readDarwinSysctl: () => memorySysctl,
    };
  };

  assert.deepEqual(readMachineQuiet(darwin("100\n1\n")), { quiet: true });
  assert.deepEqual(readMachineQuiet(darwin("99\n1\n")), {
    quiet: false,
    reason: "memory stall 1% — the machine is not quiet",
  });
});
