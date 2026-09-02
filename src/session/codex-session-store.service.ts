import { Injectable } from "@nestjs/common";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { HARNESS_NAMES, runtimeHarness, type Harness } from "../harness-routing/harness.ts";
import type { SessionCandidate } from "./session.contracts.ts";

@Injectable()
export class CodexSessionStoreService {
  async readNativeSessionCandidates(
    harness: Harness,
    homedirOrDeps:
      | (() => string)
      | {
          homedir: () => string;
          readdir?: typeof readdir;
          createReadStream?: typeof createReadStream;
        },
    readDir = readdir,
    stream = createReadStream,
  ): Promise<readonly SessionCandidate[]> {
    if (runtimeHarness(harness) !== HARNESS_NAMES.CODEX) return [];
    const homedir =
      typeof homedirOrDeps === "function" ? homedirOrDeps : homedirOrDeps.homedir;
    if (typeof homedirOrDeps !== "function") {
      readDir = homedirOrDeps.readdir ?? readDir;
      stream = homedirOrDeps.createReadStream ?? stream;
    }
    const root =
      harness === HARNESS_NAMES.CODEXY_ALL_OMNI
        ? path.join(homedir(), ".local", "share", "codexy-all-omni", "sessions")
        : path.join(homedir(), ".codex", "sessions");
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readDir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
          files.push(file);
      }
    };
    try {
      await walk(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      files.map(async (file) => {
        const fallback = path
          .basename(file)
          .match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1]
          ?.toLowerCase();
        try {
          const input = stream(file, { encoding: "utf8" });
          const lines = createInterface({ input, crlfDelay: Infinity });
          let first = "";
          for await (const line of lines) {
            first = line;
            break;
          }
          lines.close();
          input.destroy();
          const parsed = JSON.parse(first) as {
            type?: unknown;
            payload?: { id?: unknown; session_id?: unknown; cwd?: unknown };
          };
          const payload =
            parsed.type === "session_meta" ? parsed.payload : undefined;
          const id =
            typeof payload?.session_id === "string"
              ? payload.session_id
              : typeof payload?.id === "string"
                ? payload.id
                : fallback;
          return id === undefined
            ? undefined
            : {
                id: id.toLowerCase(),
                ...(typeof payload?.cwd === "string"
                  ? { cwd: payload.cwd }
                  : {}),
              };
        } catch {
          return fallback === undefined ? undefined : { id: fallback };
        }
      }),
    ).then((items) =>
      items.filter((item): item is SessionCandidate => item !== undefined),
    );
  }
}

