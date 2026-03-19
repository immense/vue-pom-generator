import type { Rule } from "eslint";
import type { AST as VueAST } from "vue-eslint-parser";

type VAttribute = VueAST.VAttribute;
type VDirective = VueAST.VDirective;
type VElement = VueAST.VElement;
type VueAttribute = VAttribute | VDirective;
type VueTemplateVisitor = {
	VElement: (node: VElement) => void;
};

function isVueTemplateFile(filename: string): boolean {
	return filename.endsWith(".vue");
}

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

function isTargetAttribute(attribute: VueAttribute, attributeName: string): boolean {
	if (!attribute.directive) {
		return attribute.key.type === "VIdentifier" && attribute.key.name === attributeName;
	}

	if (attribute.key.type !== "VDirectiveKey") {
		return false;
	}

	const directiveName = attribute.key.name;
	const argument = attribute.key.argument;

	return directiveName.type === "VIdentifier"
		&& directiveName.name === "bind"
		&& argument?.type === "VIdentifier"
		&& argument.name === attributeName;
}

function findExistingTestIdAttribute(node: VElement, attributeName: string): VueAttribute | undefined {
	return node.startTag.attributes.find(attribute => isTargetAttribute(attribute, attributeName));
}

function defineVueTemplateVisitor(
	context: Rule.RuleContext,
	templateVisitor: VueTemplateVisitor,
): Rule.RuleListener {
	const parserServices = context.sourceCode.parserServices as {
		defineTemplateBodyVisitor?: (
			templateBodyVisitor: VueTemplateVisitor,
			scriptVisitor: Rule.RuleListener,
			options: { templateBodyTriggerSelector: "Program" },
		) => Rule.RuleListener;
	};

	if (!parserServices.defineTemplateBodyVisitor) {
		return {};
	}

	return parserServices.defineTemplateBodyVisitor(
		templateVisitor,
		{},
		{ templateBodyTriggerSelector: "Program" },
	);
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
			VElement(node: VElement) {
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