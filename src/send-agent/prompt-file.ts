import { readFile } from "node:fs/promises";

/**
 * Reads a `--prompt-file` message body. `-` means stdin, which is what makes
 * a quoted heredoc usable as the safe send idiom — see the long note on
 * `PROMPT_FILE_FLAG` in `send-agent-input.ts` for the hazard this exists to
 * remove.
 *
 * Refusals are deliberately loud and specific. A send that silently posted an
 * empty message because a path was wrong would be worse than the shell
 * mangling it was introduced to prevent: at least mangled text is visibly
 * wrong to its reader.
 */
export async function readPromptFile(
  path: string,
  readStdin: () => Promise<string> = readAllStdin,
): Promise<string> {
  const raw = path === "-" ? await readStdin() : await readFileText(path);
  // A trailing newline is an artifact of how files and heredocs end, not part
  // of the message. Interior whitespace is the sender's business and is kept.
  const prompt = raw.replace(/\n+$/, "");
  if (prompt.trim() === "") {
    throw new Error(
      path === "-"
        ? "--prompt-file - read an empty message from stdin; nothing was sent"
        : `--prompt-file "${path}" is empty or whitespace-only; nothing was sent`,
    );
  }
  return prompt;
}

async function readFileText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `--prompt-file "${path}" could not be read: ${
        error instanceof Error ? error.message : String(error)
      }. Nothing was sent.`,
    );
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
