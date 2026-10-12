export class ForgeRefusal extends Error {
  override readonly name = "ForgeRefusal";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
