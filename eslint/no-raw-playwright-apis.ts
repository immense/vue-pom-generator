import type { Rule } from "eslint";

const bannedPlaywrightApis = new Set(["locator", "getByRole", "getByText", "getByLabel"]);

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

				if (
					node.callee.type !== "MemberExpression"
					|| node.callee.computed
					|| node.callee.property.type !== "Identifier"
				) {
					return;
				}

				const objectText = sourceCode.getText(node.callee.object);
				const apiName = node.callee.property.name;

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
