import path from "node:path";
import { generateCode, parseExpression, parseModule, type ASTNode, type ProxifiedObject } from "magicast";
import { replaceFileAtomically } from "../shared-policy/replace-file-atomically.ts";
import { PREVIEWS_FIELD, writeConfigModulePackageIfMissing } from "../user-config-loader.ts";
import { readTextFileIfPresent } from "../where-i-stand/file-presence.ts";

const EMPTY_CONFIG_TEXT = "export default {};\n";
const EMPTY_PREVIEWS_PROPERTY = `({ ${PREVIEWS_FIELD}: [] })`;

type ObjectNode = Extract<ASTNode, { type: "ObjectExpression" }>;
type ListNode = Extract<ASTNode, { type: "ArrayExpression" }>;
type PropertyNode = Extract<ASTNode, { type: "ObjectProperty" }>;
type ConfigModule = ReturnType<typeof parseModule>;

function configCannotBeEdited(configPath: string, reason: string): Error {
  return new Error(`${configPath} was left as it is: ${reason}`);
}

function initialValueOf(config: ConfigModule, variableName: string): ASTNode | null | undefined {
  for (const statement of (config.$ast as Extract<ASTNode, { type: "Program" }>).body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === "Identifier" && declaration.id.name === variableName) return declaration.init;
    }
  }
  return undefined;
}

function defaultExportOf(config: ConfigModule): ASTNode | null | undefined {
  const statement = (config.$ast as Extract<ASTNode, { type: "Program" }>).body.find(
    (node) => node.type === "ExportDefaultDeclaration",
  );
  const exported = statement?.declaration;
  return exported?.type === "Identifier" ? initialValueOf(config, exported.name) : exported;
}

function configObjectOf(config: ConfigModule, configPath: string): ObjectNode {
  const exported = defaultExportOf(config);
  if (exported?.type === "ObjectExpression") return exported;
  throw configCannotBeEdited(configPath, "its default export is not an object written in the file");
}

function keyNameOf({ key }: PropertyNode): string | undefined {
  if (key.type === "Identifier") return key.name;
  return key.type === "StringLiteral" ? key.value : undefined;
}

function isPreviewsProperty(node: ObjectNode["properties"][number]): node is PropertyNode {
  return node.type === "ObjectProperty" && keyNameOf(node) === PREVIEWS_FIELD;
}

function objectNodeOf(source: string): ObjectNode {
  return parseExpression<ProxifiedObject<object>>(source).$ast as ObjectNode;
}

function newPreviewsProperty(): PropertyNode {
  return objectNodeOf(EMPTY_PREVIEWS_PROPERTY).properties[0] as PropertyNode;
}

function previewsListOf(configObject: ObjectNode, configPath: string): ListNode {
  let property = configObject.properties.find(isPreviewsProperty);
  if (property === undefined) {
    property = newPreviewsProperty();
    configObject.properties.push(property);
  }
  if (property.value.type === "ArrayExpression") return property.value;
  throw configCannotBeEdited(configPath, `its ${PREVIEWS_FIELD} is not a list written in the file`);
}

function entryNode(entry: Readonly<Record<string, unknown>>): ListNode["elements"][number] {
  const fields = Object.entries(entry).map(([field, value]) => `${field}: ${JSON.stringify(value)}`);
  return objectNodeOf(`({ ${fields.join(", ")} })`);
}

async function editPreviewsList(configPath: string, edit: (list: ListNode) => void): Promise<void> {
  const text = await readTextFileIfPresent(configPath);
  if (text === undefined) {
    await writeConfigModulePackageIfMissing(path.dirname(configPath));
  }
  const config = parseModule(text ?? EMPTY_CONFIG_TEXT);
  edit(previewsListOf(configObjectOf(config, configPath), configPath));
  await replaceFileAtomically(configPath, `${generateCode(config, { format: { quote: "single" } }).code.trimEnd()}\n`);
}

export async function addPreviewToConfig(
  configPath: string,
  entry: Readonly<Record<string, unknown>>,
): Promise<void> {
  await editPreviewsList(configPath, (list) => list.elements.push(entryNode(entry)));
}

export async function removePreviewFromConfig(configPath: string, listPosition: number): Promise<void> {
  await editPreviewsList(configPath, (list) => list.elements.splice(listPosition, 1));
}
