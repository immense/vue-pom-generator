import path from "node:path";
import type { Rule } from "eslint";
import type { ArrowFunctionExpression, CallExpression, FunctionExpression } from "estree";

const DIRECT_TEST_CALLS = new Set(["test", "it"]);
const TEST_WRAPPER_CALLS = new Set(["only", "skip", "fixme", "fail"]);
const TEST_HOOK_CALLS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const SPEC_FILE_SUFFIXES = new Set([
	".spec.ts",
	".spec.tsx",
	".spec.js",
	".spec.jsx",
	".spec.cts",
	".spec.ctsx",
	".spec.cjs",
	".spec.cjsx",
	".spec.mts",
	".spec.mtsx",
	".spec.mjs",
	".spec.mjsx",
]);

function isSpecFile(filename: string): boolean {
	const basename = path.basename(filename);
	return Array.from(SPEC_FILE_SUFFIXES).some(suffix => basename.endsWith(suffix));
}

function isFunctionExpression(
	node: CallExpression["arguments"][number] | null | undefined,
): node is ArrowFunctionExpression | FunctionExpression {
	return node != null
		&& typeof node === "object"
		&& "type" in node
		&& (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression");
}

function getCallbackArgIndex(callee: CallExpression["callee"]): number | null {
	if (callee.type === "Identifier" && DIRECT_TEST_CALLS.has(callee.name))
		return 1;

	if (
		callee.type === "MemberExpression"
		&& !callee.computed
		&& callee.object.type === "Identifier"
		&& DIRECT_TEST_CALLS.has(callee.object.name)
		&& callee.property.type === "Identifier"
	) {
		if (TEST_WRAPPER_CALLS.has(callee.property.name))
			return 1;

		if (TEST_HOOK_CALLS.has(callee.property.name))
			return 0;
	}

	return null;
}

function getPageFixtureProperty(param: ArrowFunctionExpression["params"][0] | FunctionExpression["params"][0]) {
	if (!param || param.type !== "ObjectPattern")
		return null;

	for (const property of param.properties) {
		if (property.type !== "Property" || property.computed)
			continue;

		if (property.key.type === "Identifier" && property.key.name === "page")
			return property;
	}

	return null;
}

export const noPageFixtureInSpecsRule: Rule.RuleModule = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow Playwright's default `page` fixture in spec callbacks. Prefer generated fixtures and POMs instead.",
		},
		messages: {
			noPageFixture:
				"Do not destructure the default `page` fixture in spec callbacks. Use generated fixtures and POMs instead.",
		},
		schema: [],
	},
	create(context) {
		const filename = context.getFilename();
		if (!isSpecFile(filename))
			return {};

		return {
			CallExpression(node: CallExpression) {
				const callbackArgIndex = getCallbackArgIndex(node.callee);
				if (callbackArgIndex == null)
					return;

				const callback = node.arguments[callbackArgIndex];
				if (!isFunctionExpression(callback))
					return;

				const pageFixtureProperty = getPageFixtureProperty(callback.params[0]);
				if (!pageFixtureProperty)
					return;

				context.report({
					node: pageFixtureProperty,
					messageId: "noPageFixture",
				});
			},
		};
	},
};
