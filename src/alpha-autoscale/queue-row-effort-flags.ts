export function queueRowEffortFlags(effort: number | null | undefined): readonly string[] {
  if (effort === null || effort === undefined) return [];
  return ["--effort", String(effort), "--bypass-effort"];
}
