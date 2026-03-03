// @vitest-environment node
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { noRawLocatorActionRule } from "../eslint/index";

const tester = new RuleTester({
	languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("no-raw-locator-action", () => {
	it("allows POM action methods and non-POM locator calls", () => {
		tester.run("no-raw-locator-action", noRawLocatorActionRule, {
			valid: [
				// Generated POM click/fill methods — no raw locator action
				{ code: "pom.clickSubmitButton()" },
				{ code: "pom.typePersonFirstName('Alice')" },
				{ code: "pom.clickOkButton()" },
				// camelCase properties — not POM getters
				{ code: "locator.click()" },
				{ code: "element.click()" },
				// Chained from page.locator() — the object is a CallExpression, not PascalCase member
				{ code: "page.locator('.foo').click()" },
				{ code: "page.getByTestId('submit').click()" },
			],
			invalid: [
				// Direct PascalCase getter → click/fill
				{
					code: "pom.SubmitButton.click()",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.PersonFirstNameInput.fill('Alice')",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.OkButton.click()",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.PageHelpShowingButton.click()",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.ForExistingSoftware2Button.click()",
					errors: [{ messageId: "noRawAction" }],
				},
				// Chained .last()/.first()/.nth() after PascalCase getter
				{
					code: "pom.ImpersonateUserIdButton.last().click()",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.ImpersonateUserIdButton.first().click()",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.ItemRow.nth(2).click()",
					errors: [{ messageId: "noRawAction" }],
				},
				// Other action methods on POM getters
				{
					code: "pom.PersonLastNameInput.fill('Smith')",
					errors: [{ messageId: "noRawAction" }],
				},
				{
					code: "pom.ToggleButton.check()",
					errors: [{ messageId: "noRawAction" }],
				},
			],
		});
	});
});
