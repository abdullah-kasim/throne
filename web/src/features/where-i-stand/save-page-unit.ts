import { saveResponse, type SaveRequest, type SaveResponse } from "@contract/where-i-stand.ts";
import { postParsed } from "@/lib/api-client";

const BACKEND_UNREACHABLE_WORDS = "Not saved: the backend could not be reached.";

export const SAVE_ALREADY_ON_ITS_WAY_WORDS = "Not sent: a save is already on its way.";

function failureWords(error: unknown): string {
  if (error instanceof TypeError) return BACKEND_UNREACHABLE_WORDS;
  return `Not saved: ${error instanceof Error ? error.message : String(error)}.`;
}

export async function savePageUnit(change: SaveRequest): Promise<SaveResponse> {
  try {
    return await postParsed("where-i-stand/save", change, saveResponse);
  } catch (error) {
    return { outcome: "failed", message: failureWords(error) };
  }
}
