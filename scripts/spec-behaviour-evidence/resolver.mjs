import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evidenceLine } from "../spec-behaviour-evidence-line.mjs";
import {
  LINKED_WORKTREE,
  NOT_OURS_EMPTY,
  NOT_OURS_OWN_MAP_NO_SPEC,
  NOT_OURS_OWN_SPEC_NO_MAP,
  OURS_EMPTY,
  OURS_WITH_THRONE_SPECS,
  OURS_WITH_WORKTREE,
  specFileText,
} from "../spec-behaviour-evidence-fixture.mjs";

function isInside(folder, candidate) {
  const relative = path.relative(folder, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function brief(location) {
  return JSON.stringify({ owned: location.owned, spec: location.spec, map: location.map });
}

function plainFieldsOf(location) {
  const place = (artefact) =>
    artefact.path ?? `undecided, ownership unknown (ours: ${artefact.candidates.ours}; not ours: ${artefact.candidates.notOurs})`;
  return [
    ["repository", location.repository],
    ["main checkout", location.mainCheckout],
    ["settings file", location.settingsFile],
    ["owned", location.owned],
    ["spec folder", place(location.spec)],
    ["spec state", location.spec.state],
    ["map file", place(location.map)],
    ["map state", location.map.state],
  ];
}

export async function run(context) {
  const { NONE_YET, IN_THE_DATA_HOME, MADE_WITH_THRONE, MADE_ANOTHER_WAY } = context.states;
  const repositories = context.repositories;
  const resolve = async (name, ...extra) => {
    const result = await context.specLocation([repositories[name], ...extra, "--json"]);
    return { ...result, location: JSON.parse(result.stdout) };
  };
  const lines = [];

  const r1 = await resolve(OURS_EMPTY, "--owned", "yes");
  lines.push(
    evidenceLine(
      "R1",
      r1.command,
      `spec and map ${NONE_YET}, at specs and specs/FEATURE_MAP.md inside the repository`,
      brief(r1.location),
      r1.location.spec.state === NONE_YET &&
        r1.location.map.state === NONE_YET &&
        r1.location.spec.path === "specs" &&
        r1.location.map.path === "specs/FEATURE_MAP.md",
    ),
  );

  const r2 = await resolve(NOT_OURS_EMPTY, "--owned", "no");
  const r2Paths = [r2.location.spec.path, r2.location.map.path];
  lines.push(
    evidenceLine(
      "R2",
      r2.command,
      `spec and map ${NONE_YET}, both under the data home ${context.dataHome}, neither inside the repository`,
      brief(r2.location),
      r2.location.spec.state === NONE_YET &&
        r2.location.map.state === NONE_YET &&
        r2Paths.every((place) => place !== null && path.isAbsolute(place) && isInside(context.dataHome, place)) &&
        r2Paths.every((place) => !isInside(repositories[NOT_OURS_EMPTY], place)),
    ),
  );

  const fromMain = await resolve(OURS_WITH_WORKTREE, "--owned", "yes");
  const fromWorktree = await resolve(LINKED_WORKTREE, "--owned", "yes");
  const sameAnswer = (location) => JSON.stringify({ ...location, repository: undefined });
  lines.push(
    evidenceLine(
      "R3",
      `${fromMain.command} ; ${fromWorktree.command}`,
      "the same settings file, main checkout and answer from the worktree as from the main checkout",
      `main: ${sameAnswer(fromMain.location)} worktree: ${sameAnswer(fromWorktree.location)}`,
      sameAnswer(fromMain.location) === sameAnswer(fromWorktree.location) &&
        fromWorktree.location.mainCheckout === repositories[OURS_WITH_WORKTREE],
    ),
  );

  const r4 = await resolve(OURS_WITH_THRONE_SPECS);
  lines.push(
    evidenceLine(
      "R4",
      r4.command,
      `spec and map "${MADE_WITH_THRONE}"`,
      brief(r4.location),
      r4.location.spec.state === MADE_WITH_THRONE && r4.location.map.state === MADE_WITH_THRONE,
    ),
  );

  const mirrored = async (id, name, theirs, ours) => {
    const result = await resolve(name, "--owned", "no");
    const plain = await context.specLocation([repositories[name], "--owned", "no"]);
    const plainLines = plain.stdout.split("\n");
    const theirState = result.location[theirs].state;
    const ourPlace = result.location[ours].path;
    lines.push(
      evidenceLine(
        id,
        `${result.command} ; ${plain.command}`,
        `${theirs} "${MADE_ANOTHER_WAY}", ${ours} "${NONE_YET}" under the data home, each state on its own line`,
        `${brief(result.location)} plain: ${JSON.stringify(plainLines.filter((line) => line.includes("state")))}`,
        theirState === MADE_ANOTHER_WAY &&
          result.location[ours].state === NONE_YET &&
          ourPlace !== null &&
          isInside(context.dataHome, ourPlace) &&
          plainLines.includes(`spec state: ${result.location.spec.state}`) &&
          plainLines.includes(`map state: ${result.location.map.state}`),
      ),
    );
  };
  await mirrored("R5", NOT_OURS_OWN_SPEC_NO_MAP, "spec", "map");
  await mirrored("R6", NOT_OURS_OWN_MAP_NO_SPEC, "map", "spec");

  const externalFolder = context.guardPath(r2.location.spec.path);
  mkdirSync(path.join(externalFolder, "general"), { recursive: true });
  writeFileSync(
    context.guardPath(path.join(externalFolder, "general", "widget.md")),
    specFileText({ name: "Widget", summary: "Makes widgets.", code: ["README.md"] }),
  );
  const recorded = await context.specLocation([repositories[NOT_OURS_EMPTY], "--owned", "no", "--record", "spec", "--json"]);
  context.guardPath(r2.location.settingsFile);
  const reread = await resolve(NOT_OURS_EMPTY);
  const settings = JSON.parse(readFileSync(r2.location.settingsFile, "utf8"));
  lines.push(
    evidenceLine(
      "R7",
      `${recorded.command} ; ${reread.command}`,
      `settings record the spec at ${externalFolder} as "${IN_THE_DATA_HOME}"; a second run without --owned reads them`,
      `settings: ${JSON.stringify(settings)} second run: ${brief(reread.location)}`,
      recorded.code === 0 &&
        settings.spec?.path === externalFolder &&
        settings.spec?.state === IN_THE_DATA_HOME &&
        reread.location.spec.state === IN_THE_DATA_HOME &&
        reread.location.owned === "no",
    ),
  );

  const missing = [];
  const r8Commands = [];
  for (const name of [OURS_EMPTY, NOT_OURS_OWN_SPEC_NO_MAP, OURS_WITH_THRONE_SPECS]) {
    const json = await resolve(name);
    const plain = await context.specLocation([repositories[name]]);
    r8Commands.push(json.command, plain.command);
    const plainLines = plain.stdout.trimEnd().split("\n");
    const expected = plainFieldsOf(json.location).map(([label, value]) => `${label}: ${value}`);
    for (const line of plainLines) if (!expected.includes(line)) missing.push(`${name}: ${line}`);
  }
  lines.push(
    evidenceLine(
      "R8",
      r8Commands.join(" ; "),
      "every line of the plain output is carried by a JSON field with the same value",
      missing.length === 0 ? "every plain line matched a JSON field" : `plain lines without a JSON field: ${missing.join(" | ")}`,
      missing.length === 0,
    ),
  );
  return lines;
}
