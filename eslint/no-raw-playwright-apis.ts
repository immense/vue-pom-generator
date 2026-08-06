import type { Rule } from "eslint";
import type { MemberExpression } from "estree";

// Locator-filter methods available on Page/Locator/Frame etc. Banned regardless of
// the receiver object. `getByTestId` is the generator's own test-id contract — specs
// should reach it through a generated POM accessor, never a raw `*.getByTestId(...)`.
const bannedPlaywrightApis = new Set(["locator", "getByRole", "getByText", "getByLabel", "getByTestId"]);

const bannedPageApis = new Set([
	"$eval",
	"$$eval",
	"click",
	"evaluate",
	"isHidden",
	"isVisible",
	"waitForSelector",
]);

const SPEC_FILE_SUFFIXES = [".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx"];

function isSpecFile(filename: string): boolean {
	return SPEC_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

/**
 * Resolve the accessed property name from a MemberExpression callee, covering both
 * the usual member access (`page.getByTestId(...)`) and the computed equivalent
 * (`page["getByTestId"](...)`). A computed access whose key is a non-Literal
 * (e.g. `obj[dynamicKey]()`) cannot be resolved to a name, so it returns
 * `undefined` and is left alone — it could be anything at runtime.
 */
function resolveMemberPropertyName(callee: MemberExpression): string | undefined {
	const { property, computed } = callee;
	if (!computed && property.type === "Identifier") {
		return property.name;
	}
	if (computed && property.type === "Literal" && typeof property.value === "string") {
		return property.value;
	}
	return undefined;
}

export const noRawPlaywrightApisRule: Rule.RuleModule = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Ban raw Playwright APIs in spec files. Use generated fixtures/POMs or a custom POM for unsupported surfaces instead.",
		},
		messages: {
			legacyCursorHelper:
				"Do not use {{name}} in Playwright spec files. Prefer generated fixtures/POMs or a custom POM for unsupported surfaces.",
			rawPlaywrightApi:
				"Do not call {{name}} directly in Playwright spec files. Prefer generated fixtures/POM methods or a custom POM for unsupported surfaces.",
			rawPlaywrightPageApi:
				"Do not call page.{{name}} directly in Playwright spec files. Prefer generated fixtures/POM methods or a custom POM for unsupported surfaces.",
		},
		schema: [],
	},
	create(context) {
		if (!isSpecFile(context.filename)) {
			return {};
		}

		const sourceCode = context.sourceCode;

		return {
			CallExpression(node) {
				if (node.callee.type === "Identifier" && node.callee.name.includes("animateCursor")) {
					context.report({
						node: node.callee,
						messageId: "legacyCursorHelper",
						data: {
							name: node.callee.name,
						},
					});
					return;
				}

				if (node.callee.type !== "MemberExpression") {
					return;
				}

				const apiName = resolveMemberPropertyName(node.callee as MemberExpression);
				if (apiName === undefined) {
					return;
				}

				const objectText = sourceCode.getText(node.callee.object);

				if (
					(objectText === "page" || objectText === "playwrightPage")
					&& bannedPageApis.has(apiName)
				) {
					context.report({
						node: node.callee.property,
						messageId: "rawPlaywrightPageApi",
						data: {
							name: apiName,
						},
					});
					return;
				}

				if (!bannedPlaywrightApis.has(apiName)) {
					return;
				}

				context.report({
					node: node.callee.property,
					messageId: "rawPlaywrightApi",
					data: {
						name: apiName,
					},
				});
			},
		};
	},
};
