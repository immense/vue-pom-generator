import type { Rule } from "eslint";

import { defineVueTemplateVisitor, findExistingTestIdAttribute, isVueTemplateFile } from "./vue-template-rule-utils";

interface RequireExplicitStaticTestIdOptions {
	attribute?: string;
	components?: string[];
}

const DEFAULT_COMPONENTS_REQUIRING_STATIC_TEST_IDS = ["ImmyButton", "LoadButton"];

function normalizeRuleStringArrayOption(option: string[] | undefined, fallback: readonly string[]): string[] {
	if (!Array.isArray(option)) {
		return [...fallback];
	}

	const values = option.reduce<string[]>((result, value) => {
		if (typeof value !== "string") {
			return result;
		}

		const trimmedValue = value.trim();
		if (!trimmedValue) {
			return result;
		}

		result.push(trimmedValue);
		return result;
	}, []);

	return values.length > 0 ? values : [...fallback];
}

export const requireExplicitStaticTestIdRule: Rule.RuleModule = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require explicit static data-testid attributes on button-like Vue components so vue-pom-generator can emit stable selectors.",
		},
		messages: {
			missingExplicitStaticTestId:
				"{{component}} needs an explicit static {{attribute}} so vue-pom-generator does not synthesize an unstable selector.",
			dynamicTestId:
				"{{component}} must use a static {{attribute}} literal. Avoid bindings like :{{attribute}} for generated POM selectors.",
		},
		schema: [
			{
				type: "object",
				properties: {
					attribute: {
						type: "string",
						description: "Attribute name to require. Defaults to data-testid.",
					},
					components: {
						type: "array",
						items: { type: "string" },
						description: "Component names that require explicit static data-testid attributes.",
					},
				},
				additionalProperties: false,
			},
		],
	},
	create(context): Rule.RuleListener {
		if (!isVueTemplateFile(context.filename)) {
			return {};
		}

		const options = (context.options[0] ?? {}) as RequireExplicitStaticTestIdOptions;
		const attributeName = (options.attribute ?? "data-testid").trim() || "data-testid";
		const componentNames = new Set(
			normalizeRuleStringArrayOption(options.components, DEFAULT_COMPONENTS_REQUIRING_STATIC_TEST_IDS),
		);

		return defineVueTemplateVisitor(context, {
			VElement(node) {
				const componentName = node.rawName ?? node.name;
				if (!componentNames.has(componentName)) {
					return;
				}

				const existingAttribute = findExistingTestIdAttribute(node, attributeName);
				if (!existingAttribute) {
					context.report({
						node: node.startTag ?? node,
						messageId: "missingExplicitStaticTestId",
						data: { component: componentName, attribute: attributeName },
					});
					return;
				}

				if (existingAttribute.directive) {
					context.report({
						node: existingAttribute,
						messageId: "dynamicTestId",
						data: { component: componentName, attribute: attributeName },
					});
				}
			},
		});
	},
};
