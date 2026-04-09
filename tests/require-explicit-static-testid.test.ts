// @vitest-environment node
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import vueParser from "vue-eslint-parser";

import { requireExplicitStaticTestIdRule } from "../eslint/index";

const tester = new RuleTester({
	languageOptions: {
		ecmaVersion: 2022,
		sourceType: "module",
		parser: vueParser,
	},
});

describe("require-explicit-static-testid", () => {
	it("requires static test ids on targeted Vue button components", () => {
		tester.run("require-explicit-static-testid", requireExplicitStaticTestIdRule, {
			valid: [
				{
					filename: "StaticButton.vue",
					code: `<template><AppButton data-testid="SaveButton" /></template>`,
				},
				{
					filename: "StaticLoadButton.vue",
					code: `<template><LoadButton data-testid="BulkCreateFromExistingButton" /></template>`,
				},
				{
					filename: "NativeButton.vue",
					code: `<template><button>Save</button></template>`,
				},
				{
					filename: "CustomComponents.vue",
					code: `<template><AppButton data-qa="save-button" /></template>`,
					options: [{ components: ["AppButton"], attribute: "data-qa" }],
				},
				{
					filename: "RuleUsage.ts",
					code: `const attribute = "data-testid";`,
				},
			],
			invalid: [
				{
					filename: "MissingAppButton.vue",
					code: `<template><AppButton /></template>`,
					errors: [{ messageId: "missingExplicitStaticTestId" }],
				},
				{
					filename: "MissingLoadButton.vue",
					code: `<template><LoadButton /></template>`,
					errors: [{ messageId: "missingExplicitStaticTestId" }],
				},
				{
					filename: "DynamicTestId.vue",
					code: `<template><LoadButton :data-testid="buttonId" /></template>`,
					errors: [{ messageId: "dynamicTestId" }],
				},
				{
					filename: "DirectiveTestId.vue",
					code: `<template><AppButton v-bind:data-testid="buttonId" /></template>`,
					errors: [{ messageId: "dynamicTestId" }],
				},
				{
					filename: "CustomAttribute.vue",
					code: `<template><AppButton /></template>`,
					options: [{ components: ["AppButton"], attribute: "data-qa" }],
					errors: [{ messageId: "missingExplicitStaticTestId", data: { component: "AppButton", attribute: "data-qa" } }],
				},
			],
		});
	});
});
