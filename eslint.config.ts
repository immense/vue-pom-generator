import antfu from "@antfu/eslint-config";

export default antfu({
  // This package predates the repo-wide stylistic rules; keep lint focused on correctness.
  stylistic: false,
  rules: {
    "no-console": "off",
    "no-restricted-syntax": ["error",
      {
        selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Avoid type assertions to `unknown`. Fix the types instead of using `as unknown`.",
      },
      {
        selector: "TSTypeAssertion[typeAnnotation.type='TSUnknownKeyword']",
        message: "Avoid type assertions to `unknown`. Fix the types instead of using `as unknown`.",
      },
      {
        selector: "TSTypeAnnotation[typeAnnotation.type='TSUnknownKeyword']",
        message: "Avoid `: unknown` type annotations. Fix the types instead of using `unknown`.",
      },

      // This package generates source and transforms Vue AST.
      // Enforce AST-based parsing/manipulation; avoid brittle string/regex approaches.
      //
      // If you truly must use string/regex for a narrow case, add an explicit allow comment:
      //   // eslint-disable-next-line no-restricted-syntax -- allowed: <reason>
      // (and optionally also a `// @ts-ignore` comment if you want it to stand out in TS-heavy code reviews)
      {
        selector: "Literal[regex]",
        message: "Avoid RegExp literals in this package. Prefer AST-based parsing instead of regex.",
      },
      {
        selector: "NewExpression[callee.name='RegExp']",
        message: "Avoid `new RegExp(...)` in this package. Prefer AST-based parsing instead of regex.",
      },
      {
        selector: "CallExpression[callee.name='RegExp']",
        message: "Avoid `RegExp(...)` in this package. Prefer AST-based parsing instead of regex.",
      },

      // Block common string-manipulation methods that typically indicate brittle parsing.
      // NOTE: selectors cannot reliably type-check the receiver; this intentionally errs on the side of safety.
      {
        selector: "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(match|matchAll|replace|replaceAll|search|split)$/]",
        message: "Avoid string.* parsing methods in this package (match/replace/split/etc). For paths prefer node:path. For source code use AST-based parsing and structured transforms.",
      },
    ],
    "@typescript-eslint/no-explicit-any": "error",
    // Keep noise low for this package until it's formatted/sorted consistently.
    "perfectionist/sort-imports": "off",
    "perfectionist/sort-named-imports": "off",
    "jsonc/sort-keys": "off",
    "jsonc/sort-array-values": "off",
    "ts/consistent-type-imports": "off",
    // "unused-imports/no-unused-vars": "off",
    "no-template-curly-in-string": "off",
  },
}, {
  ignores: [
    "dist/**",
    "node_modules/**",
    ".vendor/**",
  ],
}, {
  files: ["**/class-generation/**/*.ts"],
  rules: {
    // These files primarily *emit* source text. Enforcing AST-only parsing here is counterproductive
    // because most operations are intentional string assembly.
    //
    // We still keep the `unknown` guards from the base config.
    "no-restricted-syntax": ["error",
      {
        selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Avoid type assertions to `unknown`. Fix the types instead of using `as unknown`.",
      },
      {
        selector: "TSTypeAssertion[typeAnnotation.type='TSUnknownKeyword']",
        message: "Avoid type assertions to `unknown`. Fix the types instead of using `as unknown`.",
      },
      {
        selector: "TSTypeAnnotation[typeAnnotation.type='TSUnknownKeyword']",
        message: "Avoid `: unknown` type annotations. Fix the types instead of using `unknown`.",
      },
    ],
  },
}, {
  files: ["**/tests/**/*.ts"],
  rules: {
    "no-console": "off",
  },
});
