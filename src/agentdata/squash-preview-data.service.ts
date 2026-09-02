// Ledger evidence for a `make-squash-commit` preview: what the scratch ref
// (`squashPreviewRef` in `../git-lifecycle/squash.ts`) was built from and
// what it is parented by. Stamped alongside the ref itself so the pair can
// never be inspected without also being able to tell whether the branches
// have drifted since — the "refuse if either has moved" rule a future
// delivery consumer checks against. Same read/write shape as
// `TreeBaseDataService`: a JSON file per agent, no class ceremony beyond
// what tests need to inject a `baseDir`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./spawn-data-contracts.ts";
import type { SquashCase } from "../git-lifecycle/squash.ts";

const SQUASH_PREVIEW_BASENAME = "squash-preview.json";

// Pinned contract: a SquashPreviewRecord is VALID FOR DELIVERY iff its
// stamped `candidateSha` equals the candidate branch's current tip AND its
// stamped `targetSha` equals the target branch's current tip. Either
// mismatch is a drift refusal — the delivery consumer names which SHA moved,
// from what to what — never a silent re-squash or a silent reuse of a stale
// preview. One predicate; a future delivery path must not grow a second ad
// hoc SHA comparison elsewhere.
export interface SquashPreviewRecord {
  scratchRef: string;
  squashCommit: string;
  squashCase: SquashCase;
  candidateSha: string;
  targetSha: string;
  targetBranch: string;
  message: string;
  preSquashSha: string;
  builtAt: string;
}

export class SquashPreviewDataService {
  async read(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<SquashPreviewRecord | null> {
    try {
      const raw = await readFile(
        path.join(baseDir, name, SQUASH_PREVIEW_BASENAME),
        "utf8",
      );
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as SquashPreviewRecord)
        : null;
    } catch {
      return null;
    }
  }

  async write(
    name: string,
    record: SquashPreviewRecord,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<void> {
    const dir = path.join(baseDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, SQUASH_PREVIEW_BASENAME),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}

export const SQUASH_PREVIEW_DATA = new SquashPreviewDataService();
