import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evidenceLine, notVerified } from "../spec-behaviour-evidence-line.mjs";
import { specFileText } from "../spec-behaviour-evidence-fixture.mjs";

function specSet(context, caseName, files) {
  const root = context.guardPath(path.join(context.scratch, "spec-sets", caseName));
  for (const codeFile of ["src/alpha.ts", "src/beta.ts"]) {
    mkdirSync(path.dirname(path.join(root, codeFile)), { recursive: true });
    writeFileSync(path.join(root, codeFile), "export {};\n");
  }
  const folder = path.join(root, "specs");
  for (const [relativePath, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, relativePath)), { recursive: true });
    writeFileSync(path.join(folder, relativePath), text);
  }
  return folder;
}

const alpha = (overrides = {}) => specFileText({ name: "Alpha", summary: "Does alpha work.", code: ["src/alpha.ts"], subFeatures: ["AL1"], ...overrides });
const beta = (overrides = {}) => specFileText({ name: "Beta", summary: "Does beta work.", code: ["src/beta.ts"], subFeatures: ["BE1"], ...overrides });

export async function run(context) {
  const lines = [];
  const fatalLine = async (id, caseName, files, expectedWords) => {
    const folder = specSet(context, caseName, files);
    const result = await context.featureMap([folder]);
    lines.push(
      evidenceLine(
        id,
        result.command,
        `non-zero exit naming ${expectedWords.join(" and ")}`,
        `exit ${result.code}: ${result.stderr.trim()}`,
        result.code !== 0 && expectedWords.every((word) => result.stderr.includes(word)),
      ),
    );
  };

  const validFolder = specSet(context, "valid", { "first/alpha.md": alpha(), "second/beta.md": beta() });
  const first = await context.featureMap([validFolder]);
  const mapPath = path.join(validFolder, "FEATURE_MAP.md");
  const firstMap = readFileSync(mapPath, "utf8");
  const mapLines = firstMap.split("\n");
  const hasLine = (name, summary, file) => mapLines.some((line) => line.includes(name) && line.includes(summary) && line.includes(`(${file})`));
  lines.push(
    evidenceLine(
      "G1",
      first.command,
      "one line per feature with its name, its one sentence and its spec file's path",
      mapLines.filter((line) => line.startsWith("- ")).join(" | "),
      first.code === 0 &&
        mapLines.filter((line) => line.startsWith("- ")).length === 2 &&
        hasLine("Alpha", "Does alpha work.", "first/alpha.md") &&
        hasLine("Beta", "Does beta work.", "second/beta.md"),
    ),
  );

  const second = await context.featureMap([validFolder]);
  const secondMap = readFileSync(mapPath, "utf8");
  lines.push(evidenceLine("G2", `${first.command} ; ${second.command}`, "byte-identical map", secondMap === firstMap ? "identical" : "different", secondMap === firstMap));

  await fatalLine("G3", "same-name", { "first/alpha.md": alpha(), "second/alpha-again.md": beta({ name: "Alpha" }) }, ["first/alpha.md", "second/alpha-again.md"]);
  await fatalLine("G4", "same-id", { "first/alpha.md": alpha(), "second/beta.md": beta({ subFeatures: ["AL1"] }) }, ["AL1", "first/alpha.md", "second/beta.md"]);

  const overlapFolder = specSet(context, "same-path", { "first/alpha.md": alpha(), "second/beta.md": beta({ code: ["src/alpha.ts"] }) });
  const overlap = await context.featureMap([overlapFolder]);
  lines.push(
    evidenceLine(
      "G5",
      overlap.command,
      "a reported finding naming both files",
      `exit ${overlap.code}: ${overlap.stderr.trim()}`,
      /reported: .*first\/alpha\.md.*second\/beta\.md/.test(overlap.stderr),
    ),
  );

  const registryFolder = specSet(context, "registry", { "first/alpha.md": alpha(), "second/beta.md": beta() });
  try {
    const registryRun = await context.featureMap([registryFolder, "--registry", "throne"]);
    const unclaimed = /registry entry (\S+) is claimed by no spec file/.exec(registryRun.stderr);
    lines.push(
      evidenceLine(
        "G6",
        registryRun.command,
        "each throne command no spec claims is reported as a gap, naming the entry",
        unclaimed === null ? `exit ${registryRun.code}: nothing reported` : `exit ${registryRun.code}: first gap ${unclaimed[1]}`,
        unclaimed !== null && registryRun.stderr.includes("reported: the registry entry spec-location is claimed by no spec file"),
      ),
    );
  } catch (error) {
    lines.push(notVerified("G6", `throne feature-map ${registryFolder} --registry throne`, "a reported gap", `the registry did not load: ${error.message}`));
  }

  await fatalLine("G7", "missing-path", { "first/alpha.md": alpha({ code: ["src/nowhere.ts"] }) }, ["first/alpha.md", "src/nowhere.ts"]);
  const longAlpha = alpha({ extraLines: 400 });
  const longLineCount = longAlpha.split("\n").length - 1;
  await fatalLine("G8", "too-long", { "first/alpha.md": longAlpha }, ["first/alpha.md", `${longLineCount} lines`]);

  lines.push(
    evidenceLine(
      "G9",
      first.command,
      "the first lines name the covered areas and say the rest is uncatalogued",
      mapLines.slice(0, 6).join(" | "),
      mapLines.slice(0, 6).includes("Covered areas: first, second.") && mapLines.slice(0, 6).some((line) => line.includes("uncatalogued")),
    ),
  );

  writeFileSync(context.guardPath(mapPath), `${firstMap}- **Hand edit**: added by hand.\n`);
  const stale = await context.featureMap([validFolder, "--check"]);
  const regenerated = await context.featureMap([validFolder]);
  const fresh = await context.featureMap([validFolder, "--check"]);
  lines.push(
    evidenceLine(
      "G10",
      `${stale.command} ; ${regenerated.command} ; ${fresh.command}`,
      "check exits non-zero saying out of date; after regenerating it exits 0 and the map is restored",
      `stale exit ${stale.code} (${stale.stderr.trim()}); fresh exit ${fresh.code}`,
      stale.code !== 0 && stale.stderr.includes("out of date") && fresh.code === 0 && readFileSync(mapPath, "utf8") === firstMap,
    ),
  );

  await fatalLine("G11", "missing-section", { "first/alpha.md": alpha({ skipSection: "## Gotchas" }) }, ["first/alpha.md", "## Gotchas"]);
  return lines;
}
