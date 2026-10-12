import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  NodeDeclaration,
  ProjectNodeReleases,
} from "./mise-node-releases.ts";
import {
  chooseNodeRelease,
  isExactNodeVersion,
  isLtsRelease,
  isNodeVersionRange,
} from "./node-release-choice.ts";

export type NodeDecidedBy = "declared" | "engines" | "throne pin";

export interface NodeChoice {
  readonly version: string;
  readonly binDirectory: string;
  readonly declared: string | null;
  readonly decidedBy: NodeDecidedBy;
  readonly reason: string;
}

type PickedNode = Omit<NodeChoice, "binDirectory">;

const ANY_NODE_RELEASE = "*";

async function newestReleaseFor(
  constraint: string,
  origin: string,
  releases: ProjectNodeReleases,
): Promise<{ readonly version: string; readonly reason: string }> {
  const choice = await chooseNodeRelease(constraint, releases);
  if (choice === null) {
    throw new Error(
      `no Node release known to mise satisfies "${constraint}" (${origin})`,
    );
  }
  const reason = choice.isLts
    ? `${choice.version} is the newest LTS release satisfying ${constraint} (${origin}), chosen through mise`
    : `no LTS satisfies ${constraint} (${origin}), so ${choice.version} is the newest release that does, chosen through mise`;
  return { version: choice.version, reason };
}

async function nodeForDeclaration(
  declaration: NodeDeclaration,
  releases: ProjectNodeReleases,
): Promise<PickedNode> {
  const { requested, resolvedVersion, sourceFile } = declaration;
  const declared = { declared: requested, decidedBy: "declared" } as const;
  if (isExactNodeVersion(requested)) {
    return {
      ...declared,
      version: resolvedVersion,
      reason: `${sourceFile} pins Node ${requested} exactly, read through mise`,
    };
  }
  if (isNodeVersionRange(requested)) {
    return {
      ...declared,
      ...(await newestReleaseFor(
        requested,
        `declared by ${sourceFile}`,
        releases,
      )),
    };
  }
  return {
    ...declared,
    version: resolvedVersion,
    reason: `mise resolves ${requested} from ${sourceFile} to ${resolvedVersion}`,
  };
}

async function readEnginesNode(projectDir: string): Promise<string | null> {
  const manifest = JSON.parse(
    await readFile(path.join(projectDir, "package.json"), "utf8"),
  ) as { engines?: { node?: unknown } };
  const enginesNode = manifest.engines?.node;
  return typeof enginesNode === "string" ? enginesNode : null;
}

async function nodeForThronePin(
  thronePin: string | null,
  releases: ProjectNodeReleases,
): Promise<PickedNode> {
  const fallback = { declared: null, decidedBy: "throne pin" } as const;
  const nothingDeclared = "the project declares no Node and no engines.node";
  if (
    thronePin !== null &&
    isLtsRelease(thronePin, await releases.newestLtsVersion())
  ) {
    return {
      ...fallback,
      version: thronePin,
      reason: `${nothingDeclared}, so the throne's pinned Node ${thronePin} (an LTS line) is used through mise`,
    };
  }
  const pinState =
    thronePin === null
      ? "the throne pins no Node"
      : `the throne pin ${thronePin} is not an LTS line`;
  const newest = await newestReleaseFor(
    ANY_NODE_RELEASE,
    `${nothingDeclared} and ${pinState}`,
    releases,
  );
  return { ...fallback, ...newest };
}

async function pickNodeForProject(
  projectDir: string,
  releases: ProjectNodeReleases,
  thronePin: string | null,
): Promise<PickedNode> {
  const declaration = await releases.projectDeclaration();
  if (declaration !== null) return nodeForDeclaration(declaration, releases);
  const enginesNode = await readEnginesNode(projectDir);
  if (enginesNode !== null) {
    return {
      declared: enginesNode,
      decidedBy: "engines",
      ...(await newestReleaseFor(
        enginesNode,
        "package.json engines.node",
        releases,
      )),
    };
  }
  return nodeForThronePin(thronePin, releases);
}

export async function nodeForProject(
  projectDir: string,
  releases: ProjectNodeReleases,
  thronePin: string | null,
): Promise<NodeChoice> {
  const picked = await pickNodeForProject(projectDir, releases, thronePin);
  const isInstalled = (await releases.installedVersions()).includes(
    picked.version,
  );
  if (!isInstalled) await releases.install(picked.version);
  return {
    ...picked,
    reason: isInstalled
      ? picked.reason
      : `${picked.reason}; installed with mise`,
    binDirectory: await releases.binDirectory(picked.version),
  };
}
