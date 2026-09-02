export function parseSingleNameToken(
  token: string,
  currentName: string | undefined,
): string {
  if (token.startsWith("--")) {
    throw new Error(`unknown flag "${token}"`);
  }
  if (currentName === undefined) {
    return token;
  }
  throw new Error(`unexpected argument "${token}"`);
}
