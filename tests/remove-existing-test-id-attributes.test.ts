// @vitest-environment node
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import vueParser from "vue-eslint-parser";

import { removeExistingTestIdAttributesRule } from "../eslint/index";

const tester = new RuleTester({
	languageOptions: {
		ecmaVersion: 2022,
		sourceType: "module",
		parser: vueParser,
	},
});

describe("remove-existing-test-id-attributes", () => {
	it("removes explicit static and bound test-id attributes from Vue templates", () => {
		tester.run("remove-existing-test-id-attributes", removeExistingTestIdAttributesRule, {
			valid: [
				{
					filename: "Component.vue",
					code: `<template><button class="primary">Save</button></template>`,
				},
				{
					filename: "CommentOnly.vue",
					code: `<template><!-- <button data-testid="comment-only">Save</button> --></template>`,
				},
				{
					filename: "Component.ts",
					code: `const attribute = "data-testid";`,
				},
			],
			invalid: [
				{
					filename: "StaticButton.vue",
					code: `<template><button data-testid="save-button" class="primary">Save</button></template>`,
					output: `<template><button class="primary">Save</button></template>`,
					errors: [{ messageId: "removeExistingTestIdAttribute" }],
				},
				{
					filename: "BoundButton.vue",
					code: `<template><button :data-testid="buttonId" class="primary">Save</button></template>`,
					output: `<template><button class="primary">Save</button></template>`,
					errors: [{ messageId: "removeExistingTestIdAttribute" }],
				},
				{
					filename: "DirectiveButton.vue",
					code: `<template><button v-bind:data-testid="buttonId" class="primary">Save</button></template>`,
					output: `<template><button class="primary">Save</button></template>`,
					errors: [{ messageId: "removeExistingTestIdAttribute" }],
				},
				{
					filename: "CustomAttribute.vue",
					code: `<template><button data-qa="save-button" class="primary">Save</button></template>`,
					options: [{ attribute: "data-qa" }],
					output: `<template><button class="primary">Save</button></template>`,
					errors: [{ messageId: "removeExistingTestIdAttribute", data: { attribute: "data-qa" } }],
				},
				{
					filename: "NestedObjectProperty.vue",
					code: `<script setup>const editorOptions = { inputAttr: { 'data-testid': 'save-button', placeholder: 'Firm' } };</script>`,
					output: `<script setup>const editorOptions = { inputAttr: { placeholder: 'Firm' } };</script>`,
					errors: [{ messageId: "removeExistingTestIdAttribute" }],
				},
				{
					filename: "InlineObjectProperty.vue",
					code: `<template><DxSimpleItem :editor-options="{ inputAttr: { 'data-testid': 'save-button', placeholder: 'Firm' } }" /></template>`,
					output: `<template><DxSimpleItem :editor-options="{ inputAttr: { placeholder: 'Firm' } }" /></template>`,
					errors: [{ messageId: "removeExistingTestIdAttribute" }],
				},
			],
		});
	});
});
