import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const ENTRY_TEXT = "- Links: no pull request\n- Kind: bug fix — put by name\n- Where it stands: building\n";
const SECTION_NAMES = ["Needs you", "In flight", "Queued and deferred", "Delivered, not on GitHub", "On GitHub"];

async function putBySectionName(code: string, sectionName: string, address: string) {
  const script = [
    'const { runWhereIStand } = await import("./src/where-i-stand/where-i-stand-runtime.ts");',
    'const { connectToWhereIStand } = await import("./src/where-i-stand-store/where-i-stand-client.ts");',
    "let said = '';",
    `const exitCode = await runWhereIStand(["put", "--code", ${JSON.stringify(code)}, "--section", ${JSON.stringify(sectionName)}, "--text", ${JSON.stringify(ENTRY_TEXT)}], {`,
    `  connect: () => connectToWhereIStand({ local: false, address: ${JSON.stringify(address)} }),`,
    '  currentAgentName: async () => "alpha-e2e-agent",',
    "  out: (message) => { said += message; },",
    "  err: (message) => { said += message; },",
    "});",
    "process.stdout.write(JSON.stringify({ exitCode, said }));",
  ].join("\n");
  const { stdout } = await promisify(execFile)("bun", ["--eval", script], { encoding: "utf8" });
  return JSON.parse(stdout) as { exitCode: number; said: string };
}

test("adding a row with a section name instead of an id is refused", async ({ request, baseURL }) => {
  for (const [index, sectionName] of SECTION_NAMES.entries()) {
    const code = `alpha-by-name-${index}`;
    const answer = await putBySectionName(code, sectionName, baseURL!);
    expect(answer.exitCode).toBe(1);
    expect(answer.said).toContain("does not find a section by name");
    const page = await (await request.get("/api/where-i-stand/store/page")).json();
    expect(JSON.stringify(page.rows)).not.toContain(code);
  }
});
