import { mkdir, lstat, readlink, symlink, unlink } from "node:fs/promises";
import path from "node:path";

export type ExtensionInstallOutcome =
  | { readonly kind: "harness-absent"; readonly probed: string }
  | { readonly kind: "installed-ahead-of-first-run"; readonly link: string; readonly executable: string }
  | { readonly kind: "already-current"; readonly link: string }
  | { readonly kind: "installed"; readonly link: string; readonly replaced?: string }
  | { readonly kind: "blocked"; readonly link: string; readonly reason: string };

export interface ExtensionInstallDeps {
  readonly agentDir: string;
  readonly source: string;
  readonly linkName: string;
  readonly linkFolder?: string;
  readonly findExecutable: () => Promise<string | undefined>;
}

async function pathKind(
  target: string,
): Promise<"absent" | "symlink" | "other"> {
  try {
    const stats = await lstat(target);
    return stats.isSymbolicLink() ? "symlink" : "other";
  } catch {
    return "absent";
  }
}

export async function installDeliveryExtension(
  deps: ExtensionInstallDeps,
): Promise<ExtensionInstallOutcome> {
  const agentDir = deps.agentDir;
  let aheadOfFirstRun: string | undefined;
  if ((await pathKind(agentDir)) === "absent") {
    const executable = await deps.findExecutable();
    if (executable === undefined) {
      return { kind: "harness-absent", probed: agentDir };
    }
    await mkdir(agentDir, { recursive: true });
    aheadOfFirstRun = executable;
  }
  const extensionsDir = path.join(agentDir, deps.linkFolder ?? "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const link = path.join(extensionsDir, deps.linkName);

  const kind = await pathKind(link);
  if (kind === "other") {
    return {
      kind: "blocked",
      link,
      reason:
        "a real file or directory already occupies that path; refusing to " +
        "delete it. Move it aside if the throne should own this name.",
    };
  }
  if (kind === "symlink") {
    let current: string | undefined;
    try {
      current = await readlink(link);
    } catch {
      current = undefined;
    }
    if (current !== undefined && path.resolve(current) === path.resolve(deps.source)) {
      return { kind: "already-current", link };
    }
    await unlink(link);
    await symlink(deps.source, link);
    return { kind: "installed", link, ...(current === undefined ? {} : { replaced: current }) };
  }
  await symlink(deps.source, link);
  return aheadOfFirstRun === undefined
    ? { kind: "installed", link }
    : { kind: "installed-ahead-of-first-run", link, executable: aheadOfFirstRun };
}
