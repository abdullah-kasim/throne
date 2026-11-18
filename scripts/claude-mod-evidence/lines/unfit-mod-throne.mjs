import { execFile } from "node:child_process";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function trustFolder(harness, folder) {
  for (const file of [path.join(harness.home, ".claude.json"), path.join(harness.claudeConfig, ".claude.json")]) {
    const settings = JSON.parse(await readFile(file, "utf8"));
    settings.projects = { ...settings.projects, [folder]: { hasTrustDialogAccepted: true } };
    await writeFile(file, JSON.stringify(settings));
  }
}

export async function throneWithUnfitMod(harness) {
  const root = path.join(harness.root, "throne-with-unfit-mod");
  await mkdir(root, { recursive: true });
  for (const name of ["package.json", "mise.toml", "bin"]) await cp(path.join(repositoryRoot, name), path.join(root, name), { recursive: true });
  await cp(path.join(repositoryRoot, "dist"), path.join(root, "dist"), { recursive: true, dereference: true });
  for (const name of ["node_modules", "vendor", "src", "claude-hooks"]) await symlink(path.join(repositoryRoot, name), path.join(root, name));
  const mod = path.join(root, "extensions", "claude");
  await mkdir(path.join(mod, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(mod, "hooks"), { recursive: true });
  await writeFile(path.join(mod, ".claude-plugin", "plugin.json"), '{"name":"throne-delivery","version":"1.0.0"}\n');
  await writeFile(path.join(mod, "hooks", "hooks.json"), '{ "modules": ["./unfit.ts"] }\n');
  await writeFile(path.join(mod, "hooks", "unfit.ts"), 'export default function ($: any) {\n  $.clock.every(250, () => $.fs.remove("/nowhere"))\n}\n');
  await run("git", ["init", "-q"], { cwd: root });
  await trustFolder(harness, root);
  return root;
}
