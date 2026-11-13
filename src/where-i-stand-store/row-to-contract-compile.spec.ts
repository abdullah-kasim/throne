import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const schemaPath = path.join(repositoryRoot, "src/where-i-stand-store/where-i-stand.schema.ts");
const mappingPath = path.join(repositoryRoot, "src/where-i-stand-store/row-to-contract.ts");

const compilerOptions: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  types: [],
};

function compileMapping(schemaText: string, previousProgram?: ts.Program): { program: ts.Program; errors: string } {
  const host = ts.createCompilerHost(compilerOptions);
  const readFromDisk = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    path.resolve(fileName) === schemaPath
      ? ts.createSourceFile(fileName, schemaText, languageVersion)
      : readFromDisk(fileName, languageVersion, ...rest);
  const program = ts.createProgram([mappingPath], compilerOptions, host, previousProgram);
  const errors = ts.getPreEmitDiagnostics(program)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) return `error TS${diagnostic.code}: ${message}`;
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${path.basename(diagnostic.file.fileName)}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}`;
    })
    .join("\n");
  return { program, errors };
}

test("renaming a where-i-stand column the page shows makes the mapping to the contract fail to compile", async () => {
  const schema = await readFile(schemaPath, "utf8");
  const original = compileMapping(schema);
  assert.equal(original.errors, "");
  const renamed = compileMapping(schema.replace(/^(\s+)whereItStands: text\(/m, "$1standing: text("), original.program);
  assert.match(renamed.errors, /row-to-contract\.ts\(\d+,\d+\): error TS2339: Property 'whereItStands' does not exist/);
});
