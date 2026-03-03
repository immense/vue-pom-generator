import type { Rule } from "eslint";
import type { CallExpression, Expression, MemberExpression } from "estree";

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
]);

/**
 * Locator chain methods that are transparent for the purposes of this rule —
 * `.last().click()` is still a raw action on a POM getter.
 */
const CHAIN_METHODS = new Set(["last", "first", "nth", "filter"]);

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
		if (/^[A-Z]/.test(name)) return name;
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

export const plugin = {
	rules: {
		"no-raw-locator-action": noRawLocatorActionRule,
	},
} satisfies { rules: Record<string, Rule.RuleModule> };
