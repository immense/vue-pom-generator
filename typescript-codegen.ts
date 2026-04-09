import {
  CodeBlockWriter,
  IndentationText,
  NewLineKind,
  Project,
  QuoteKind,
  StructureKind,
  type ClassDeclaration,
  type ClassDeclarationStructure,
  type ConstructorDeclarationStructure,
  type ExportDeclarationStructure,
  type GetAccessorDeclarationStructure,
  type ImportDeclarationStructure,
  type MethodDeclarationStructure,
  type OptionalKind,
  type ParameterDeclarationStructure,
  type PropertyDeclarationStructure,
  type SourceFile,
  type WriterFunction,
} from "ts-morph";

export { VariableDeclarationKind } from "ts-morph";
export {
  StructureKind,
  type ClassDeclarationStructure,
  type ConstructorDeclarationStructure,
  type ExportDeclarationStructure,
  type GetAccessorDeclarationStructure,
  type ImportDeclarationStructure,
  type MethodDeclarationStructure,
  type OptionalKind,
  type ParameterDeclarationStructure,
  type PropertyDeclarationStructure,
  type WriterFunction,
};

export type TypeScriptWriter = CodeBlockWriter;
export type TypeScriptSourceFile = SourceFile;
export type TypeScriptClassMember =
  | OptionalKind<ConstructorDeclarationStructure>
  | OptionalKind<GetAccessorDeclarationStructure>
  | OptionalKind<MethodDeclarationStructure>
  | OptionalKind<PropertyDeclarationStructure>;

function createTypeScriptProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: {
      indentationText: IndentationText.FourSpaces,
      newLineKind: NewLineKind.LineFeed,
      quoteKind: QuoteKind.Double,
      useTrailingCommas: false,
    },
  });
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function createTypeScriptWriter(): TypeScriptWriter {
  return new CodeBlockWriter({
    newLine: "\n",
    useTabs: false,
    indentNumberOfSpaces: 4,
  });
}

export function renderTypeScript(write: (writer: TypeScriptWriter) => void): string {
  const writer = createTypeScriptWriter();
  write(writer);
  return ensureTrailingNewline(writer.toString());
}

export function renderTypeScriptLines(lines: string[]): string {
  return renderTypeScript((writer) => {
    for (const line of lines) {
      writer.writeLine(line);
    }
  });
}

export function buildCommentBlock(lines: string[]): string {
  return renderTypeScript((writer) => {
    writer.writeLine("/**");
    for (const line of lines) {
      writer.writeLine(` * ${line}`);
    }
    writer.writeLine(" */");
  });
}

export function buildFilePrefix(options: {
  referenceLib?: string;
  eslintDisableSortImports?: boolean;
  commentLines?: string[];
} = {}): string {
  let prefix = "";
  if (options.referenceLib) {
    prefix += `/// <reference lib="${options.referenceLib}" />\n`;
  }
  if (options.eslintDisableSortImports) {
    prefix += "/* eslint-disable perfectionist/sort-imports */\n";
  }
  if (options.commentLines?.length) {
    prefix += buildCommentBlock(options.commentLines);
  }
  return prefix;
}

export function renderSourceFile(
  filePath: string,
  build: (sourceFile: TypeScriptSourceFile) => void,
  options: {
    prefixText?: string;
  } = {},
): string {
  const project = createTypeScriptProject();
  const sourceFile = project.createSourceFile(filePath, "", { overwrite: true });
  build(sourceFile);
  const content = ensureTrailingNewline(sourceFile.getFullText());
  return options.prefixText
    ? ensureTrailingNewline(`${options.prefixText}${content}`)
    : content;
}

function renderClassDeclarationMembers(classDeclaration: ClassDeclaration): string {
  const memberTexts = classDeclaration.getMembers().map(member => member.getText());
  return memberTexts.length > 0
    ? ensureTrailingNewline(memberTexts.join("\n\n"))
    : "";
}

export function renderClassMembers(members: TypeScriptClassMember[]): string {
  const project = createTypeScriptProject();
  const sourceFile = project.createSourceFile("__members.ts", "", { overwrite: true });
  const classDeclaration = sourceFile.addClass({ name: "__Temp" });
  for (const member of members) {
    switch (member.kind) {
      case StructureKind.Constructor:
        classDeclaration.addConstructor(member);
        break;
      case StructureKind.GetAccessor:
        classDeclaration.addGetAccessor(member);
        break;
      case StructureKind.Method:
        classDeclaration.addMethod(member);
        break;
      case StructureKind.Property:
        classDeclaration.addProperty(member);
        break;
      default:
        throw new Error(`Unsupported class member kind: ${String(member.kind)}`);
    }
  }
  return renderClassDeclarationMembers(classDeclaration);
}

export function writeCommentBlock(writer: TypeScriptWriter, lines: string[]): void {
  writer.write(buildCommentBlock(lines));
}

export function addNamedImport(
  sourceFile: TypeScriptSourceFile,
  options: {
    moduleSpecifier: string;
    namedImports: Array<string | { name: string; alias?: string }>;
    isTypeOnly?: boolean;
  },
) {
  return sourceFile.addImportDeclaration({
    moduleSpecifier: options.moduleSpecifier,
    isTypeOnly: options.isTypeOnly,
    namedImports: options.namedImports,
  });
}

export function addExportAll(sourceFile: TypeScriptSourceFile, moduleSpecifier: string) {
  return sourceFile.addExportDeclaration({ moduleSpecifier });
}

export function createClassMethod(
  method: Omit<OptionalKind<MethodDeclarationStructure>, "kind">,
): TypeScriptClassMember {
  return {
    kind: StructureKind.Method,
    ...method,
  };
}

export function createClassProperty(
  property: Omit<OptionalKind<PropertyDeclarationStructure>, "kind">,
): TypeScriptClassMember {
  return {
    kind: StructureKind.Property,
    ...property,
  };
}

export function createClassGetter(
  getter: Omit<OptionalKind<GetAccessorDeclarationStructure>, "kind">,
): TypeScriptClassMember {
  return {
    kind: StructureKind.GetAccessor,
    ...getter,
  };
}

export function createClassConstructor(
  constructorDeclaration: OptionalKind<ConstructorDeclarationStructure>,
): TypeScriptClassMember {
  return {
    kind: StructureKind.Constructor,
    ...constructorDeclaration,
  };
}
