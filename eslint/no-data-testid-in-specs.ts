import type { Rule } from "eslint";
import type { CallExpression, Literal, MemberExpression, TemplateLiteral } from "estree";

function includesDataTestId(value: Literal["value"]): value is string {
  return typeof value === "string" && value.includes("data-testid");
}

export const noDataTestIdInSpecsRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw data-testid strings and getByTestId calls in Playwright specs.",
    },
    messages: {
      noDataTestIdInSpecs: "Avoid data-testid in spec files; use a generated POM or fixture accessor instead.",
      noGetByTestIdInSpecs: "Avoid getByTestId(...) in spec files; use a generated POM or fixture accessor instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node: Literal) {
        if (includesDataTestId(node.value)) {
          context.report({ node, messageId: "noDataTestIdInSpecs" });
        }
      },
      TemplateLiteral(node: TemplateLiteral) {
        const staticText = node.quasis.map(quasi => quasi.value.cooked).join("");
        if (includesDataTestId(staticText)) {
          context.report({ node, messageId: "noDataTestIdInSpecs" });
        }
      },
      CallExpression(node: CallExpression) {
        if (node.callee.type !== "MemberExpression")
          return;

        const callee = node.callee as MemberExpression;
        const isGetByTestId = !callee.computed
          ? callee.property.type === "Identifier" && callee.property.name === "getByTestId"
          : callee.property.type === "Literal" && callee.property.value === "getByTestId";

        if (isGetByTestId) {
          context.report({ node, messageId: "noGetByTestIdInSpecs" });
        }
      },
    };
  },
};
