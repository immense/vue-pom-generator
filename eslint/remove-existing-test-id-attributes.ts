import type { Rule } from "eslint";
import type { VueAttribute } from "./vue-template-rule-utils";
import { defineVueTemplateVisitor, findExistingTestIdAttribute, isVueTemplateFile } from "./vue-template-rule-utils";

function isWhitespaceCharacter(character: string): boolean {
	return character === " "
		|| character === "\t"
		|| character === "\n"
		|| character === "\r"
		|| character === "\f";
}

function removeAttributeWithWhitespace(
	attribute: VueAttribute,
	context: Rule.RuleContext,
	fixer: Rule.RuleFixer,
): Rule.Fix {
	const sourceText = context.sourceCode.getText();
	const [start, end] = attribute.range;

	let adjustedStart = start;
	while (adjustedStart > 0 && isWhitespaceCharacter(sourceText[adjustedStart - 1])) {
		adjustedStart -= 1;
	}

	return fixer.removeRange([adjustedStart, end]);
}

export const removeExistingTestIdAttributesRule: Rule.RuleModule = {
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Remove existing test-id attributes from Vue templates so vue-pom-generator can generate them consistently.",
		},
		fixable: "code",
		messages: {
			removeExistingTestIdAttribute:
				"Remove explicit {{attribute}}. vue-pom-generator can generate it; run this rule with --fix to clean legacy attributes project-wide.",
		},
		schema: [
			{
				type: "object",
				properties: {
					attribute: {
						type: "string",
						description: "Attribute name to remove. Defaults to data-testid.",
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

		const options = (context.options[0] ?? {}) as { attribute?: string };
		const attributeName = (options.attribute ?? "data-testid").trim() || "data-testid";

		return defineVueTemplateVisitor(context, {
			VElement(node) {
				const existingAttribute = findExistingTestIdAttribute(node, attributeName);
				if (!existingAttribute) {
					return;
				}

				context.report({
					node: existingAttribute,
					messageId: "removeExistingTestIdAttribute",
					data: { attribute: attributeName },
					fix(fixer) {
						return removeAttributeWithWhitespace(existingAttribute, context, fixer);
					},
				});
			},
		});
	},
};
