import type { Rule } from "eslint";
import type { AST as VueAST } from "vue-eslint-parser";

export type VAttribute = VueAST.VAttribute;
export type VDirective = VueAST.VDirective;
export type VElement = VueAST.VElement;
export type VueAttribute = VAttribute | VDirective;
export interface VueTemplateVisitor {
	VElement: (node: VElement) => void;
}

export function isVueTemplateFile(filename: string): boolean {
	return filename.endsWith(".vue");
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

export function findExistingTestIdAttribute(node: VElement, attributeName: string): VueAttribute | undefined {
	return node.startTag.attributes.find(attribute => isTargetAttribute(attribute, attributeName));
}

export function defineVueTemplateVisitor(
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
