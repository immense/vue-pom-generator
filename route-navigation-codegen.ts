import { getParamToken } from "./router-introspection";
import { POM_ROUTER_GLOBAL_NAME } from "./router-bridge";
import type { TypeScriptWriter, WriterFunction } from "./typescript-codegen";

export interface NavigationPathParam {
  name: string;
  optional: boolean;
}

export interface NavigationInput {
  identifier: string;
  optional: boolean;
}

export type NavigationTargetSelection =
  | { kind: "single"; target: string }
  | {
      kind: "dual";
      paramlessTarget: string;
      parametrizedTarget: string;
      selectBy: "input-presence" | "path-param-presence";
    };

export interface RouterNavigationWriterOptions {
  routeName: NavigationTargetSelection;
  input?: NavigationInput;
  pathParamNames: string[];
  queryNames: string[];
}

export interface UrlNavigationWriterOptions {
  routeTemplate: NavigationTargetSelection;
  input?: NavigationInput;
  pathParams: NavigationPathParam[];
  queryNames: string[];
}

function writeNavigationValue(
  writer: TypeScriptWriter,
  input: NavigationInput,
  name: string,
): void {
  writer.write(input.identifier);
  if (input.optional) {
    writer.write("?.");
  }
  writer.write(`[${JSON.stringify(name)}]`);
}

function writeFilteredNavigationRecord(
  writer: TypeScriptWriter,
  variableName: "routeParams" | "routeQuery",
  input: NavigationInput | undefined,
  names: string[],
): void {
  writer.write(`const ${variableName} = `);
  if (!input || names.length === 0) {
    writer.write("{};").newLine();
    return;
  }

  writer.write("Object.fromEntries([");
  names.forEach((name, index) => {
    if (index > 0) {
      writer.write(", ");
    }
    writer.write(`[${JSON.stringify(name)}, `);
    writeNavigationValue(writer, input, name);
    writer.write("]");
  });
  writer.write("].filter(([, value]) => value !== undefined));").newLine();
}

function writeUnpartitionedRouteParams(
  writer: TypeScriptWriter,
  input: NavigationInput | undefined,
): void {
  writer.write("const routeParams = ");
  if (!input) {
    writer.write("{};").newLine();
    return;
  }

  writer.write("Object.fromEntries(Object.entries(");
  writer.write(input.identifier);
  if (input.optional) {
    writer.write(" ?? {}");
  }
  writer.write(").filter(([, v]) => v !== undefined));").newLine();
}

function writeRouterTargetType(writer: TypeScriptWriter, includeQuery: boolean): void {
  writer.write("{ name: string; params: Record<string, unknown>");
  if (includeQuery) {
    writer.write("; query: Record<string, unknown>");
  }
  writer.write(" }");
}

function writeRouterType(writer: TypeScriptWriter, includeQuery: boolean): void {
  writer.write(`{ ${POM_ROUTER_GLOBAL_NAME}?: { push: (to: `);
  writeRouterTargetType(writer, includeQuery);
  writer.write(") => Promise<unknown>; resolve: (to: ");
  writeRouterTargetType(writer, includeQuery);
  writer.write(") => { href: string } } }");
}

function writeRouterBinding(writer: TypeScriptWriter, includeQuery: boolean): void {
  writer.write("{ name, params");
  if (includeQuery) {
    writer.write(", query");
  }
  writer.write(" }");
}

function writeRouterTarget(
  writer: TypeScriptWriter,
  writeName: WriterFunction,
  includeQuery: boolean,
  paramsExpression: string,
  queryExpression: string,
): void {
  writer.write("{ name: ");
  writeName(writer);
  writer.write(`, params: ${paramsExpression}`);
  if (includeQuery) {
    writer.write(`, query: ${queryExpression}`);
  }
  writer.write(" }");
}

function requireNavigationInput(
  input: NavigationInput | undefined,
  context: string,
): NavigationInput {
  if (!input) {
    throw new Error(`${context} requires a navigation input.`);
  }
  return input;
}

function writeParametrizedRouteSelector(
  writer: TypeScriptWriter,
  input: NavigationInput,
  pathParamNames: string[],
): void {
  writer.write(`const useParametrizedRoute = ${input.identifier} !== undefined && [`);
  pathParamNames.forEach((name, index) => {
    if (index > 0) {
      writer.write(", ");
    }
    writer.write(JSON.stringify(name));
  });
  writer.write(`].some(key => Object.prototype.hasOwnProperty.call(${input.identifier}, key));`).newLine();
}

function writeSelectionPrelude(
  writer: TypeScriptWriter,
  selection: NavigationTargetSelection,
  input: NavigationInput | undefined,
  pathParamNames: string[],
): void {
  if (selection.kind === "dual" && selection.selectBy === "path-param-presence") {
    writeParametrizedRouteSelector(
      writer,
      requireNavigationInput(input, "Path-param route selection"),
      pathParamNames,
    );
  }
}

function writeSelectedTarget(
  writer: TypeScriptWriter,
  selection: NavigationTargetSelection,
  input: NavigationInput | undefined,
): void {
  if (selection.kind === "single") {
    writer.write(JSON.stringify(selection.target));
    return;
  }

  if (selection.selectBy === "path-param-presence") {
    writer.write("useParametrizedRoute");
  }
  else {
    writer.write(requireNavigationInput(input, "Input-presence route selection").identifier);
  }
  writer.write(` ? ${JSON.stringify(selection.parametrizedTarget)} : ${JSON.stringify(selection.paramlessTarget)}`);
}

/**
 * Emits the complete named-route navigation body. The caller supplies route metadata;
 * this writer owns params/query partitioning and both the cold-load and warm-router paths.
 */
export function createRouterNavigationWriter(options: RouterNavigationWriterOptions): WriterFunction {
  return (writer) => {
    writeSelectionPrelude(writer, options.routeName, options.input, options.pathParamNames);
    const writeRouteName: WriterFunction = nameWriter => writeSelectedTarget(nameWriter, options.routeName, options.input);

    const includeQuery = options.queryNames.length > 0;
    if (includeQuery) {
      writeFilteredNavigationRecord(writer, "routeParams", options.input, options.pathParamNames);
      writeFilteredNavigationRecord(writer, "routeQuery", options.input, options.queryNames);
    }
    else {
      // Preserve the compact output for routes whose input contains only path params.
      writeUnpartitionedRouteParams(writer, options.input);
    }

    writer.writeLine(
      `const isCold = await this.page.evaluate(() => typeof (globalThis as { ${POM_ROUTER_GLOBAL_NAME}?: unknown }).${POM_ROUTER_GLOBAL_NAME} === "undefined");`,
    );
    writer.writeLine("if (isCold) {");
    writer.indent(() => {
      writer.writeLine('await this.page.goto("/", { waitUntil: "commit" });');
      writer.writeLine(
        `await this.page.waitForFunction(() => typeof (globalThis as { ${POM_ROUTER_GLOBAL_NAME}?: unknown }).${POM_ROUTER_GLOBAL_NAME} !== "undefined", { timeout: 15000 });`,
      );
      writer.write("const href = await this.page.evaluate((");
      writeRouterBinding(writer, includeQuery);
      writer.write(") => (globalThis as ");
      writeRouterType(writer, includeQuery);
      writer.write(`).${POM_ROUTER_GLOBAL_NAME}?.resolve(`);
      writeRouterBinding(writer, includeQuery);
      writer.write(")?.href, ");
      writeRouterTarget(writer, writeRouteName, includeQuery, "routeParams", "routeQuery");
      writer.write(");").newLine();
      writer.writeLine("if (href) {");
      writer.indent(() => {
        writer.writeLine('await this.page.goto(href, { waitUntil: "domcontentloaded" });');
      });
      writer.writeLine("}");
    });
    writer.writeLine("} else {");
    writer.indent(() => {
      writer.write("await this.page.evaluate(async (");
      writeRouterBinding(writer, includeQuery);
      writer.write(") => {").newLine();
      writer.indent(() => {
        writer.write("await (globalThis as ");
        writeRouterType(writer, includeQuery);
        writer.write(`).${POM_ROUTER_GLOBAL_NAME}?.push(`);
        writeRouterBinding(writer, includeQuery);
        writer.write(");").newLine();
      });
      writer.write("}, ");
      writeRouterTarget(writer, writeRouteName, includeQuery, "routeParams", "routeQuery");
      writer.write(");").newLine();
    });
    writer.writeLine("}");
  };
}

function writePathParamAssignments(
  writer: TypeScriptWriter,
  input: NavigationInput,
  pathParams: NavigationPathParam[],
): void {
  for (const param of pathParams) {
    const token = getParamToken(param.name);
    if (param.optional) {
      writer.write("targetUrl = ");
      writeNavigationValue(writer, input, param.name);
      writer.write(` === undefined ? targetUrl.replaceAll(${JSON.stringify(`/${token}`)}, "") : targetUrl.replaceAll(${JSON.stringify(token)}, String(`);
      writeNavigationValue(writer, input, param.name);
      writer.write("));").newLine();
    }
    else {
      writer.write(`targetUrl = targetUrl.replaceAll(${JSON.stringify(token)}, String(`);
      writeNavigationValue(writer, input, param.name);
      writer.write("));").newLine();
    }
  }
}

function writeQueryString(
  writer: TypeScriptWriter,
  input: NavigationInput,
  queryNames: string[],
): void {
  if (queryNames.length === 0) {
    return;
  }

  writer.writeLine("const routeQuery = new URLSearchParams();");
  for (const queryName of queryNames) {
    writer.write("if (");
    writeNavigationValue(writer, input, queryName);
    writer.write(" !== undefined) {").newLine();
    writer.indent(() => {
      writer.write(`routeQuery.set(${JSON.stringify(queryName)}, String(`);
      writeNavigationValue(writer, input, queryName);
      writer.write("));").newLine();
    });
    writer.writeLine("}");
  }
  writer.writeLine("const routeQueryString = routeQuery.toString();");
  writer.writeLine("if (routeQueryString) {");
  writer.indent(() => {
    writer.writeLine('targetUrl += `?${routeQueryString}`;');
  });
  writer.writeLine("}");
}

function writeRuntimeUrlNavigation(writer: TypeScriptWriter): void {
  writer.writeLine(
    "const runtimeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;",
  );
  writer.writeLine(
    "const runtimeBaseUrl = runtimeEnv?.PLAYWRIGHT_RUNTIME_BASE_URL ?? runtimeEnv?.PLAYWRIGHT_TEST_BASE_URL ?? runtimeEnv?.VITE_PLAYWRIGHT_BASE_URL;",
  );
  writer.writeLine("const resolvedUrl = runtimeBaseUrl ? new URL(targetUrl, runtimeBaseUrl).toString() : targetUrl;");
  writer.writeLine("await this.page.goto(resolvedUrl);");
}

/** Emits the complete URL-construction navigation body used for unnamed routes. */
export function createUrlNavigationWriter(options: UrlNavigationWriterOptions): WriterFunction {
  return (writer) => {
    writeSelectionPrelude(writer, options.routeTemplate, options.input, options.pathParams.map(param => param.name));
    if (options.routeTemplate.kind === "single") {
      writer.write(`let targetUrl = ${JSON.stringify(options.routeTemplate.target)};`).newLine();
    }
    else {
      writer.write("const template = ");
      writeSelectedTarget(writer, options.routeTemplate, options.input);
      writer.write(";").newLine();
      writer.writeLine("let targetUrl = template;");
    }

    if (options.pathParams.length > 0) {
      const input = requireNavigationInput(options.input, "URL navigation with path params");

      if (options.routeTemplate.kind === "dual") {
        writer.write("if (");
        writer.write(input.identifier);
        if (options.routeTemplate.selectBy === "path-param-presence") {
          writer.write(" && useParametrizedRoute");
        }
        writer.write(") {").newLine();
        writer.indent(() => {
          writePathParamAssignments(writer, input, options.pathParams);
        });
        writer.writeLine("}");
      }
      else {
        writePathParamAssignments(writer, input, options.pathParams);
      }
    }

    if (options.queryNames.length > 0) {
      writeQueryString(
        writer,
        requireNavigationInput(options.input, "URL navigation with query params"),
        options.queryNames,
      );
    }

    writeRuntimeUrlNavigation(writer);
  };
}
