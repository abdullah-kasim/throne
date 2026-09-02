// Ledger read/write for a delivered agent's DeliveryEvidenceRecord (see
// ./delivery-evidence-record.ts for the pinned shape and why it exists). Same
// read/write shape as TreeBaseDataService/SquashPreviewDataService: a JSON
// file per agent, no class ceremony beyond what tests need to inject a
// baseDir.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DIR } from "./spawn-data-contracts.ts";
import type { DeliveryEvidenceRecord } from "./delivery-evidence-record.ts";

const DELIVERY_EVIDENCE_BASENAME = "delivery-evidence.json";

export class DeliveryEvidenceDataService {
  async read(
    name: string,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<DeliveryEvidenceRecord | null> {
    try {
      const raw = await readFile(
        path.join(baseDir, name, DELIVERY_EVIDENCE_BASENAME),
        "utf8",
      );
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as DeliveryEvidenceRecord)
        : null;
    } catch {
      return null;
    }
  }

  async write(
    name: string,
    record: DeliveryEvidenceRecord,
    baseDir: string = DEFAULT_DATA_DIR,
  ): Promise<void> {
    const dir = path.join(baseDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, DELIVERY_EVIDENCE_BASENAME),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
  }
}

export const DELIVERY_EVIDENCE_DATA = new DeliveryEvidenceDataService();
