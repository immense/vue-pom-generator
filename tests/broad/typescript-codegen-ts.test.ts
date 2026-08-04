// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  addExportAll,
  addNamedImport,
  buildCommentBlock,
  buildFilePrefix,
  createClassConstructor,
  createClassGetter,
  createClassMethod,
  createClassProperty,
  createTypeScriptWriter,
  renderClassMembers,
  renderSourceFile,
  renderTypeScript,
  renderTypeScriptLines,
  type TypeScriptClassMember,
  writeCommentBlock,
} from "../../typescript-codegen";

describe("typescript-codegen.ts", () => {
  it("ensureTrailingNewline adds a newline when missing (via renderTypeScript)", () => {
    // A single write() with no trailing newline exercises the missing-newline branch.
    const out = renderTypeScript((writer) => {
      writer.write("no-newline");
    });
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toBe("no-newline\n");
  });

  it("does not double-add a trailing newline (via renderTypeScriptLines)", () => {
    const out = renderTypeScriptLines(["a", "b"]);
    expect(out).toBe("a\nb\n");
  });

  it("createTypeScriptWriter produces a usable writer", () => {
    const writer = createTypeScriptWriter();
    writer.writeLine("hello");
    expect(writer.toString()).toContain("hello");
  });

  it("buildFilePrefix emits reference lib, eslint-disable, and comment block", () => {
    const prefix = buildFilePrefix({
      referenceLib: "dom",
      eslintDisableSortImports: true,
      commentLines: ["Generated file", "Do not edit"],
    });
    expect(prefix).toContain('/// <reference lib="dom" />');
    expect(prefix).toContain("/* eslint-disable perfectionist/sort-imports */");
    expect(prefix).toContain("Generated file");
    expect(prefix).toContain("Do not edit");
  });

  it("buildFilePrefix returns empty string for no options", () => {
    expect(buildFilePrefix()).toBe("");
  });

  it("buildCommentBlock renders a multi-line doc comment", () => {
    const block = buildCommentBlock(["One", "Two"]);
    expect(block).toContain("/**");
    expect(block).toContain(" * One");
    expect(block).toContain(" * Two");
    expect(block).toContain(" */");
  });

  it("writeCommentBlock writes a comment block onto a writer", () => {
    const writer = createTypeScriptWriter();
    writeCommentBlock(writer, ["Header"]);
    expect(writer.toString()).toContain("Header");
  });

  it("renderSourceFile builds statements and applies a prefix", () => {
    const content = renderSourceFile(
      "test.ts",
      (sf) => {
        sf.addStatements('const x = 1;');
      },
      { prefixText: "// prefix\n" },
    );
    expect(content.startsWith("// prefix\n")).toBe(true);
    expect(content).toContain("const x = 1");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("renderSourceFile without prefix does not prepend anything", () => {
    const content = renderSourceFile("test.ts", (sf) => {
      sf.addStatements('const y = 2;');
    });
    expect(content).toContain("const y = 2");
    expect(content.startsWith("//")).toBe(false);
  });

  it("addNamedImport and addExportAll modify the source file", () => {
    const content = renderSourceFile("test.ts", (sf) => {
      addNamedImport(sf, { moduleSpecifier: "vue", namedImports: [{ name: "ref", alias: "r" }], isTypeOnly: true });
      addExportAll(sf, "./other");
    });
    expect(content).toContain('from "vue"');
    expect(content).toContain("ref as r");
    expect(content).toContain('export * from "./other"');
  });

  it("renderClassMembers renders each member kind (constructor, getter, method, property)", () => {
    const members = [
      createClassConstructor({ parameters: [], statements: ["this.x = 1;"] }),
      createClassGetter({ name: "value", returnType: "number", statements: ["return 2;"] }),
      createClassMethod({ name: "doThing", parameters: [{ name: "n", type: "string" }], returnType: "void", statements: ["console.log(n);"] }),
      createClassProperty({ name: "flag", type: "boolean", initializer: "false" }),
    ];

    const rendered = renderClassMembers(members);
    expect(rendered).toContain("constructor");
    expect(rendered).toContain("get value()");
    expect(rendered).toContain("doThing(");
    expect(rendered).toContain("flag");
    expect(rendered).toContain("boolean");
  });

  it("renderClassMembers returns empty text when there are no members (empty-members branch)", () => {
    expect(renderClassMembers([])).toBe("");
  });

  it("renderClassMembers throws for an unsupported member kind", () => {
    // @ts-expect-error intentionally invalid member kind (9999 is not a supported StructureKind) to exercise the unsupported-kind error path
    const bad: TypeScriptClassMember = { kind: 9999 };
    expect(() => renderClassMembers([bad])).toThrow(/Unsupported class member kind/);
  });
});
