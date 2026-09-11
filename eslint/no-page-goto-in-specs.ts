import type { Rule } from "eslint";
import type { CallExpression, MemberExpression } from "estree";

// Same module-suffix set as no-page-fixture-in-specs so both rules gate the identical
// spec-file forms (including the cts/mts variants the flat/recommended config targets).
const SPEC_FILE_SUFFIXES = [
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
];

function isSpecFile(filename: string): boolean {
	return SPEC_FILE_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

/**
 * Resolve the accessed property name from a MemberExpression callee, covering both
 * the usual member access (`page.goto(...)`) and the computed equivalent
 * (`page["goto"](...)`). A computed access whose key is a non-Literal (e.g.
 * `obj[dynamicKey]()`) cannot be resolved to a name, so it returns `undefined`
 * and is left alone — it could be anything at runtime.
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

/**
 * True when `node` is a member expression whose receiver is literally named
 * `page` or `playwrightPage`. Property chains are not followed: only the direct
 * receiver identifier is inspected, so `page.screencast.goto()` is not flagged.
 */
function receiverIsRawPage(node: MemberExpression): boolean {
	const object = node.object;
	if (object.type !== "Identifier") {
		return false;
	}
	return object.name === "page" || object.name === "playwrightPage";
}

/**
 * Disallow raw `page.goto(...)` / `playwrightPage.goto(...)` in Playwright spec
 * files. A raw goto is a full browser navigation: the SPA re-bootstraps, replaying
 * the splash screen and losing all client state. Generated POM `goTo()` methods
 * navigate through the app's Vue Router, which is what specs (and demo recordings)
 * should use.
 */
export const noPageGotoInSpecsRule: Rule.RuleModule = {
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow raw `page.goto(...)` in spec files. Prefer the generated POM `goTo()` router-bridge navigation.",
		},
		messages: {
			rawPageGoto:
				"Do not call {{object}}.goto() directly in spec files — it performs a full browser navigation and re-bootstraps the SPA. Use a generated POM's `goTo()` (router-bridge navigation) instead.",
		},
		schema: [],
	},
	create(context) {
		if (!isSpecFile(context.filename)) {
			return {};
		}

		return {
			CallExpression(node: CallExpression) {
				if (node.callee.type !== "MemberExpression") {
					return;
				}

				const callee = node.callee;
				const apiName = resolveMemberPropertyName(callee);
				if (apiName !== "goto") {
					return;
				}

				if (!receiverIsRawPage(callee)) {
					return;
				}

				context.report({
					node: callee.property,
					messageId: "rawPageGoto",
					data: { object: callee.object.type === "Identifier" ? callee.object.name : "page" },
				});
			},
		};
	},
};
