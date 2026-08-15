import type { Rule } from "eslint";
import type { CallExpression, Expression, MemberExpression } from "estree";
import playwrightEslint from "eslint-plugin-playwright";

import { noDataTestIdInSpecsRule } from "./no-data-testid-in-specs";
import { noPageFixtureInSpecsRule } from "./no-page-fixture-in-specs";
import { noRawPlaywrightApisRule } from "./no-raw-playwright-apis";
import { removeExistingTestIdAttributesRule } from "./remove-existing-test-id-attributes";

/**
 * Playwright locator action methods that should be called via generated POM
 * methods rather than directly on element getters.
 */
const LOCATOR_ACTIONS = new Set([
	"click",
	"dblclick",
	"fill",
	"check",
	"uncheck",
	"type",
	"clear",
	"selectOption",
	"setInputFiles",
	"tap",
	"hover",
	"focus",
	"dispatchEvent",
	"press",
	"selectText",
	"scrollIntoViewIfNeeded",
]);

const RAW_POM_ACTION_HELPERS = new Set(["clickByTestId", "clickLocator"]);

/**
 * Locator chain methods that are transparent for the purposes of this rule —
 * `.last().click()` is still a raw action on a POM getter.
 */
const CHAIN_METHODS = new Set(["last", "first", "nth", "filter"]);

function startsWithUppercaseLetter(value: string): boolean {
	const first = value.charCodeAt(0);
	return first >= 65 && first <= 90;
}

/**
 * Returns the PascalCase getter name if `node` is (or chains from) a direct
 * PascalCase member-expression access.  Returns null otherwise.
 *
 * Handles:
 *   pom.SubmitButton            → "SubmitButton"
 *   pom.SubmitButton.last()     → "SubmitButton"
 *   pom.SubmitButton.nth(0)     → "SubmitButton"
 */
function getPomGetterName(node: Expression): string | null {
	if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
		const name = node.property.name;
		if (startsWithUppercaseLetter(name)) return name;
	}

	if (
		node.type === "CallExpression"
		&& node.callee.type === "MemberExpression"
		&& !node.callee.computed
		&& node.callee.property.type === "Identifier"
		&& CHAIN_METHODS.has(node.callee.property.name)
	) {
		return getPomGetterName((node.callee as MemberExpression).object as Expression);
	}

	return null;
}

export const noRawLocatorActionRule: Rule.RuleModule = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Disallow calling raw Playwright action methods directly on POM element getters. Use the generated typed POM methods instead (e.g. `clickSubmitButton()`).",
		},
		messages: {
			noRawAction:
				"Use the generated POM method instead of `{{getter}}.{{method}}()`. "
				+ "Call `click{{getter}}()` / `type{{getter}}(text)` or similar.",
			noRawPomActionHelper:
				"Use the generated POM action instead of the low-level `{{method}}()` helper.",
		},
		schema: [],
	},
	create(context) {
		return {
			CallExpression(node: CallExpression) {
				if (node.callee.type !== "MemberExpression") return;
				const callee = node.callee as MemberExpression;
				if (callee.computed || callee.property.type !== "Identifier") return;

				const methodName = callee.property.name;
				if (RAW_POM_ACTION_HELPERS.has(methodName)) {
					context.report({
						node,
						messageId: "noRawPomActionHelper",
						data: { method: methodName },
					});
					return;
				}
				if (!LOCATOR_ACTIONS.has(methodName)) return;

				const getterName = getPomGetterName(callee.object as Expression);
				if (!getterName) return;

				context.report({
					node,
					messageId: "noRawAction",
					data: { getter: getterName, method: methodName },
				});
			},
		};
	},
};

const rules = {
	"no-data-testid-in-specs": noDataTestIdInSpecsRule,
	"no-page-fixture-in-specs": noPageFixtureInSpecsRule,
	"no-raw-locator-action": noRawLocatorActionRule,
	"no-raw-playwright-apis": noRawPlaywrightApisRule,
	"remove-existing-test-id-attributes": removeExistingTestIdAttributesRule,
};

type FlatConfig = {
	files?: string[];
	languageOptions?: Record<string, unknown>;
	plugins?: Record<string, unknown>;
	rules?: Record<string, unknown>;
};

export const plugin: {
	rules: typeof rules;
	configs: Record<string, FlatConfig[]>;
} = {
	rules,
	configs: {},
};

const playwrightRecommended = playwrightEslint.configs["flat/recommended"] as FlatConfig;
const playwrightFiles = ["**/tests/playwright/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

plugin.configs["flat/recommended"] = [
	{
		...playwrightRecommended,
		files: playwrightFiles,
		rules: {
			"playwright/no-force-option": "error",
			"playwright/no-networkidle": "error",
			"playwright/no-wait-for-selector": "error",
			"playwright/no-wait-for-timeout": "error",
			"playwright/prefer-web-first-assertions": "error",
		},
	},
	{
		files: playwrightFiles,
		plugins: {
			"@immense/vue-pom-generator": plugin,
		},
		rules: {
			"@immense/vue-pom-generator/no-data-testid-in-specs": "error",
			"@immense/vue-pom-generator/no-page-fixture-in-specs": "error",
			"@immense/vue-pom-generator/no-raw-locator-action": "error",
			"@immense/vue-pom-generator/no-raw-playwright-apis": "error",
		},
	},
];

export const recommendedPlaywrightConfig = plugin.configs["flat/recommended"];

export { noPageFixtureInSpecsRule };
export { noDataTestIdInSpecsRule };
export { noRawPlaywrightApisRule };
export { removeExistingTestIdAttributesRule };
