import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";

const SCRATCH_PANE_FOLDER_NAME = "scratch-panes";
const MARKER_FILE_EXTENSION = ".json";

export interface ScratchPaneMarker {
  readonly paneId: string;
  readonly owner: string;
  readonly until: string;
  readonly reported: boolean;
}

function scratchPaneFolder(environment: NodeJS.ProcessEnv): string {
  return path.join(resolveThroneHome(environment), SCRATCH_PANE_FOLDER_NAME);
}

function scratchPaneMarkerPath(paneId: string, environment: NodeJS.ProcessEnv): string {
  return path.join(scratchPaneFolder(environment), `${encodeURIComponent(paneId)}${MARKER_FILE_EXTENSION}`);
}

function folderIsMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function writeScratchPaneMarker(
  marker: ScratchPaneMarker,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const markerPath = scratchPaneMarkerPath(marker.paneId, environment);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return markerPath;
}

export async function readScratchPaneMarkers(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ScratchPaneMarker[]> {
  const folder = scratchPaneFolder(environment);
  let fileNames: string[];
  try {
    fileNames = await readdir(folder);
  } catch (error) {
    if (folderIsMissing(error)) return [];
    throw error;
  }
  return Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(MARKER_FILE_EXTENSION))
      .map(async (fileName) => JSON.parse(await readFile(path.join(folder, fileName), "utf8")) as ScratchPaneMarker),
  );
}
