import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export async function replaceFileAtomically(file: string, content: string): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, content, "utf8");
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}
