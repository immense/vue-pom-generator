import { CodeBlockWriter } from "ts-morph";

export type TypeScriptWriter = CodeBlockWriter;

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
  return writer.toString();
}

export function renderTypeScriptLines(lines: string[]): string {
  return renderTypeScript((writer) => {
    for (const line of lines) {
      writer.writeLine(line);
    }
  });
}

export function writeCommentBlock(writer: TypeScriptWriter, lines: string[]): void {
  writer.writeLine("/**");
  for (const line of lines) {
    writer.writeLine(` * ${line}`);
  }
  writer.writeLine(" */");
}
