import type { Rule } from "eslint";
import type { Property } from "estree";
import type { AST as VueAST } from "vue-eslint-parser";

type VAttribute = VueAST.VAttribute;
type VDirective = VueAST.VDirective;
type VElement = VueAST.VElement;
type VExpressionContainer = VueAST.VExpressionContainer;
type VueAttribute = VAttribute | VDirective;
type VueTemplateVisitor = {
	VElement: (node: VElement) => void;
	VExpressionContainer?: (node: VExpressionContainer) => void;
};
type VueScriptVisitor = Rule.RuleListener;

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

function isTargetObjectProperty(node: unknown, attributeName: string): node is Property {
	if (!node || typeof node !== "object" || !("type" in node) || node.type !== "Property") {
		return false;
	}

	if (!("computed" in node) || node.computed) {
		return false;
	}

	const property = node as Property;
	const key = property.key;

	return (key.type === "Literal" && key.value === attributeName)
		|| (key.type === "Identifier" && key.name === attributeName);
}

function removeObjectPropertyWithComma(
	property: Property,
	fixer: Rule.RuleFixer,
): Rule.Fix {
	const getRequiredRange = (node: { range?: [number, number] | null }, label: string): [number, number] => {
		if (!node.range) {
			throw new Error(`[vue-pom-generator] Expected ${label} node range while removing an existing test id.`);
		}

		return node.range;
	};

	const parent = ("parent" in property ? property.parent : null) as { type?: string; properties?: Property[] } | null;
	const siblings = parent?.type === "ObjectExpression" && Array.isArray(parent.properties)
		? parent.properties
		: null;
	const propertyRange = getRequiredRange(property, "property");

	if (siblings) {
		const index = siblings.indexOf(property);
		const nextSibling = index >= 0 ? siblings[index + 1] : null;
		if (nextSibling) {
			const nextSiblingRange = getRequiredRange(nextSibling, "next sibling");
			return fixer.removeRange([propertyRange[0], nextSiblingRange[0]]);
		}

		const previousSibling = index > 0 ? siblings[index - 1] : null;
		if (previousSibling) {
			const previousSiblingRange = getRequiredRange(previousSibling, "previous sibling");
			return fixer.removeRange([previousSiblingRange[1], propertyRange[1]]);
		}
	}

	return fixer.removeRange([propertyRange[0], propertyRange[1]]);
}

function walkEstree(node: unknown, visit: (current: unknown) => void): void {
	if (!node || typeof node !== "object") {
		return;
	}

	visit(node);

	if (Array.isArray(node)) {
		for (const child of node) {
			walkEstree(child, visit);
		}
		return;
	}

	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (key === "parent") {
			continue;
		}

		if (!value || typeof value !== "object") {
			continue;
		}

		if (Array.isArray(value)) {
			for (const child of value) {
				walkEstree(child, visit);
			}
			continue;
		}

		if ("type" in value) {
			walkEstree(value, visit);
		}
	}
}

function defineVueTemplateVisitor(
	context: Rule.RuleContext,
	templateVisitor: VueTemplateVisitor,
	scriptVisitor: VueScriptVisitor = {},
): Rule.RuleListener {
	const parserServices = context.sourceCode.parserServices as {
		defineTemplateBodyVisitor?: (
			templateBodyVisitor: VueTemplateVisitor,
			scriptVisitor?: Rule.RuleListener,
		) => Rule.RuleListener;
	};

	if (!parserServices.defineTemplateBodyVisitor) {
		return scriptVisitor;
	}

	return parserServices.defineTemplateBodyVisitor(templateVisitor, scriptVisitor);
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

		const reportExistingAttribute = (node: VueAttribute | Property) => {
			context.report({
				node,
				messageId: "removeExistingTestIdAttribute",
				data: { attribute: attributeName },
				fix(fixer) {
					if ("directive" in node) {
						return removeAttributeWithWhitespace(node, context, fixer);
					}

					return removeObjectPropertyWithComma(node, fixer);
				},
			});
		};

		return defineVueTemplateVisitor(
			context,
			{
				VElement(node: VElement) {
					const existingAttribute = findExistingTestIdAttribute(node, attributeName);
					if (!existingAttribute) {
						return;
					}

					reportExistingAttribute(existingAttribute);
				},
				VExpressionContainer(node: VExpressionContainer) {
					if (!node.expression) {
						return;
					}

					walkEstree(node.expression, (current) => {
						if (!isTargetObjectProperty(current, attributeName)) {
							return;
						}

						reportExistingAttribute(current);
					});
				},
			},
			{
				Property(node) {
					if (!isTargetObjectProperty(node, attributeName)) {
						return;
					}

					reportExistingAttribute(node);
				},
			},
		);
	},
};
