import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import ts from "typescript";

export interface CommandProviderFact {
  readonly name: string;
  readonly providerName: string;
  readonly sourcePath: string;
}

export interface CommandRegistryException {
  readonly providerName: string;
  readonly reason: string;
}

export interface CommandRegistryCoverage {
  readonly errors: readonly string[];
}

export const INTENTIONAL_COMMAND_REGISTRY_EXCEPTIONS: readonly CommandRegistryException[] =
  [];

async function sourceFilesUnder(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sourcePaths: string[] = [];
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      sourcePaths.push(...(await sourceFilesUnder(entryPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      sourcePaths.push(entryPath);
    }
  }
  return sourcePaths.sort();
}

function importedCommandDecoratorName(
  sourceFile: ts.SourceFile,
): string | undefined {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "nest-commander"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const commandImport = bindings.elements.find(
      (element) => (element.propertyName ?? element.name).text === "Command",
    );
    if (commandImport) return commandImport.name.text;
  }
  return undefined;
}

function commandNameFromDecorator(
  declaration: ts.ClassDeclaration,
  decoratorName: string,
): string | undefined {
  for (const decorator of ts.getDecorators(declaration) ?? []) {
    if (
      !ts.isCallExpression(decorator.expression) ||
      !ts.isIdentifier(decorator.expression.expression) ||
      decorator.expression.expression.text !== decoratorName
    ) {
      continue;
    }
    const options = decorator.expression.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    const nameProperty = options.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === "name") ||
          (ts.isStringLiteral(property.name) && property.name.text === "name")),
    );
    if (nameProperty && ts.isStringLiteralLike(nameProperty.initializer)) {
      return nameProperty.initializer.text;
    }
    return undefined;
  }
  return undefined;
}

async function discoverCommandProvidersInFile(
  sourceRoot: string,
  sourcePath: string,
  readSourceFile: (sourcePath: string) => Promise<string>,
): Promise<readonly CommandProviderFact[]> {
  const sourceText = await readSourceFile(sourcePath);
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const decoratorName = importedCommandDecoratorName(sourceFile);
  if (!decoratorName) return [];
  const facts: CommandProviderFact[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const isCommandProvider = (ts.getDecorators(statement) ?? []).some(
      (decorator) =>
        ts.isCallExpression(decorator.expression) &&
        ts.isIdentifier(decorator.expression.expression) &&
        decorator.expression.expression.text === decoratorName,
    );
    if (!isCommandProvider) continue;
    const providerName = statement.name?.text;
    const name = commandNameFromDecorator(statement, decoratorName);
    const relativePath = relative(sourceRoot, sourcePath).replaceAll("\\", "/");
    if (!providerName || !name) {
      throw new Error(
        `${relativePath}: @Command providers must use a named class and a literal name`,
      );
    }
    facts.push({ name, providerName, sourcePath: relativePath });
  }
  return facts;
}

export async function discoverCommandProviders(
  sourceRoot: string,
  readSourceFile: (sourcePath: string) => Promise<string> = (sourcePath) =>
    readFile(sourcePath, "utf8"),
): Promise<readonly CommandProviderFact[]> {
  const sourcePaths = await sourceFilesUnder(sourceRoot);
  const facts: CommandProviderFact[] = [];
  for (const sourcePath of sourcePaths) {
    facts.push(
      ...(await discoverCommandProvidersInFile(
        sourceRoot,
        sourcePath,
        readSourceFile,
      )),
    );
  }
  return facts;
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

export function classifyCommandRegistryCoverage(
  discovered: readonly CommandProviderFact[],
  registered: readonly CommandProviderFact[],
  exceptions: readonly CommandRegistryException[],
): CommandRegistryCoverage {
  const errors: string[] = [];
  const discoveredByProvider = new Map(
    discovered.map((fact) => [fact.providerName, fact]),
  );
  const registeredByProvider = new Map(
    registered.map((fact) => [fact.providerName, fact]),
  );
  const exceptionsByProvider = new Map(
    exceptions.map((entry) => [entry.providerName, entry]),
  );

  for (const providerName of duplicates(
    discovered.map((fact) => fact.providerName),
  )) {
    errors.push(`duplicate discovered provider: ${providerName}`);
  }
  for (const providerName of duplicates(
    registered.map((fact) => fact.providerName),
  )) {
    errors.push(`duplicate registry provider: ${providerName}`);
  }
  for (const providerName of duplicates(
    exceptions.map((entry) => entry.providerName),
  )) {
    errors.push(`duplicate exception: ${providerName}`);
  }
  for (const exception of exceptions) {
    if (exception.reason.trim().length === 0) {
      errors.push(`exception has no reason: ${exception.providerName}`);
    }
    if (!discoveredByProvider.has(exception.providerName)) {
      errors.push(`stale exception target: ${exception.providerName}`);
    }
    if (registeredByProvider.has(exception.providerName)) {
      errors.push(
        `registered provider must not remain excepted: ${exception.providerName}`,
      );
    }
  }
  for (const fact of discovered) {
    const registryFact = registeredByProvider.get(fact.providerName);
    if (!registryFact && !exceptionsByProvider.has(fact.providerName)) {
      errors.push(
        `unregistered command provider: ${fact.sourcePath} exports ${fact.providerName} as ${fact.name}`,
      );
    } else if (registryFact && registryFact.name !== fact.name) {
      errors.push(
        `command name mismatch: ${fact.providerName} declares ${fact.name} but registry uses ${registryFact.name}`,
      );
    }
  }
  for (const fact of registered) {
    if (!discoveredByProvider.has(fact.providerName)) {
      errors.push(
        `registry provider has no @Command declaration: ${fact.providerName}`,
      );
    }
  }
  return { errors: errors.sort() };
}

export function assertCommandRegistryCoverage(
  coverage: CommandRegistryCoverage,
): void {
  if (coverage.errors.length > 0) {
    throw new Error(
      `Command registry coverage failed:\n${coverage.errors.join("\n")}`,
    );
  }
}
