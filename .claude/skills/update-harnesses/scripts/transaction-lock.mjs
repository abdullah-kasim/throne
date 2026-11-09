import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LOCK_NAME = '.transaction-lock';
const OWNER_FILE = 'owner';

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLockOwner(lock) {
  const ownerPath = path.join(lock, OWNER_FILE);
  const owner = existsSync(ownerPath) ? Number(readFileSync(ownerPath, 'utf8')) : 0;
  return owner > 0 ? owner : null;
}

function takeLock(lock) {
  mkdirSync(lock);
  writeFileSync(path.join(lock, OWNER_FILE), `${process.pid}\n`);
}

export function acquireTransactionLock(managedRoot, { holder = 'harness update transaction', speaker = 'update-harness' } = {}) {
  mkdirSync(managedRoot, { recursive: true });
  const lock = path.join(managedRoot, LOCK_NAME);
  if (!existsSync(lock)) {
    takeLock(lock);
    return lock;
  }
  const owner = readLockOwner(lock);
  if (owner !== null && processIsRunning(owner)) {
    throw new Error(`another ${holder} is already running (process ${owner})`);
  }
  process.stderr.write(`${speaker}: taking over the transaction lock left by dead process ${owner ?? 'unknown'}\n`);
  rmSync(lock, { recursive: true, force: true });
  takeLock(lock);
  return lock;
}
