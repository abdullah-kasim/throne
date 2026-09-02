import { readStartFailureAnnotation } from "../../herdr/herdr-launch-context.ts";

export function startFailureOwnershipIsAmbiguous(error: unknown): boolean {
  return readStartFailureAnnotation(error)?.ownership === "indeterminate";
}
