// @vitest-environment node
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { noPageFixtureInSpecsRule, noRawLocatorActionRule, noRawPlaywrightApisRule } from "../eslint/index";

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

describe("no-page-fixture-in-specs", () => {
	it("flags Playwright page fixture destructuring in spec callbacks only", () => {
		tester.run("no-page-fixture-in-specs", noPageFixtureInSpecsRule, {
			valid: [
				{
					code: "test('uses generated fixture', async ({ dashboardPage }) => { await dashboardPage.goTo(); });",
					filename: "/tmp/dashboard.spec.ts",
				},
				{
					code: "test.beforeEach(async ({ personListPage }) => { await personListPage.goTo(); });",
					filename: "/tmp/person.spec.ts",
				},
				{
					code: "test('uses a POM page property', async ({ dashboardPage }) => { await dashboardPage.page.goto('/dashboard'); });",
					filename: "/tmp/dashboard.spec.ts",
				},
				{
					code: "const helper = async ({ page }) => { return page; };",
					filename: "/tmp/person.spec.ts",
				},
				{
					code: "test.extend({ personOperations: async ({ page }, use) => { await use({}); } });",
					filename: "/tmp/personFixture.ts",
				},
			],
			invalid: [
				{
					code: "test('uses raw page', async ({ page }) => { await page.goto('/'); });",
					filename: "/tmp/dashboard.spec.ts",
					errors: [{ messageId: "noPageFixture" }],
				},
				{
					code: "test('uses page with another fixture', async ({ page, dashboardPage }) => { await page.goto('/'); });",
					filename: "/tmp/dashboard.spec.ts",
					errors: [{ messageId: "noPageFixture" }],
				},
				{
					code: "test.beforeEach(async ({ page }) => { await page.goto('/'); });",
					filename: "/tmp/dashboard.spec.ts",
					errors: [{ messageId: "noPageFixture" }],
				},
				{
					code: "test.skip('skipped test', async ({ page }) => { await page.goto('/'); });",
					filename: "/tmp/dashboard.spec.ts",
					errors: [{ messageId: "noPageFixture" }],
				},
				{
					code: "it('aliases page', async ({ page: currentPage }) => { await currentPage.goto('/'); });",
					filename: "/tmp/dashboard.spec.ts",
					errors: [{ messageId: "noPageFixture" }],
				},
			],
		});
	});
});
 
describe("no-raw-playwright-apis", () => {
	it("allows generated fixture/POM usage in spec files", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [
				{
					code: "test('example', async ({ tagsListPage }) => { await tagsListPage.clickRemove(); });",
					filename: "/tmp/example.spec.ts",
				},
			],
			invalid: [],
		});
	});

	it("ignores non-spec files", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [
				{
					code: "export function useHelper(page) { return page.getByText('ok'); }",
					filename: "/tmp/helpers.ts",
				},
			],
			invalid: [],
		});
	});

	it("flags animateCursor helper calls", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [],
			invalid: [
				{
					code: "animateCursorToElementAndClick(page, '#btn');",
					filename: "/tmp/example.spec.ts",
					errors: [{ messageId: "legacyCursorHelper" }],
				},
			],
		});
	});

	it("flags raw locator query APIs", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [],
			invalid: [
				{
					code: "page.locator('button'); page.getByRole('button'); page.getByText('Save'); page.getByLabel('Name');",
					filename: "/tmp/example.spec.ts",
					errors: [
						{ messageId: "rawPlaywrightApi" },
						{ messageId: "rawPlaywrightApi" },
						{ messageId: "rawPlaywrightApi" },
						{ messageId: "rawPlaywrightApi" },
					],
				},
			],
		});
	});

	it("flags direct page selector APIs", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [],
			invalid: [
				{
					code: "await page.click('#save'); await page.evaluate(() => 1); await page.waitForSelector('#save');",
					filename: "/tmp/example.spec.ts",
					errors: [
						{ messageId: "rawPlaywrightPageApi" },
						{ messageId: "rawPlaywrightPageApi" },
						{ messageId: "rawPlaywrightPageApi" },
					],
				},
			],
		});
	});

	it("flags getByTestId in spec files", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [],
			invalid: [
				{
					code: "page.getByTestId('save-button');",
					filename: "/tmp/example.spec.ts",
					errors: [{ messageId: "rawPlaywrightApi" }],
				},
				{
					// getByTestId is a locator-filter method (like getByRole/getByText),
					// so it is banned regardless of the receiver object.
					code: "someLocator.getByTestId('save-button');",
					filename: "/tmp/example.spec.ts",
					errors: [{ messageId: "rawPlaywrightApi" }],
				},
				{
					// A template-literal arg is still a raw getByTestId call.
					code: "page.getByTestId(`edit-person-btn-${id}`);",
					filename: "/tmp/example.spec.ts",
					errors: [{ messageId: "rawPlaywrightApi" }],
				},
			],
		});
	});

	it("flags computed-member access to banned APIs", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [],
			invalid: [
				{
					// Computed string-literal access (`obj["name"]()`) previously slipped
					// through the `!callee.computed` guard; the fix resolves the property
					// name from a string Literal too.
					code: "page['getByTestId']('save'); page['locator']('button'); page['getByRole']('button');",
					filename: "/tmp/example.spec.ts",
					errors: [
						{ messageId: "rawPlaywrightApi" },
						{ messageId: "rawPlaywrightApi" },
						{ messageId: "rawPlaywrightApi" },
					],
				},
				{
					// Computed page-level APIs are reported with the page message.
					code: "page['click']('#save');",
					filename: "/tmp/example.spec.ts",
					errors: [{ messageId: "rawPlaywrightPageApi" }],
				},
			],
		});
	});

	it("allows computed access to non-banned APIs and dynamic keys", () => {
		tester.run("no-raw-playwright-apis", noRawPlaywrightApisRule, {
			valid: [
				{
					// A computed name that is not a banned API is fine.
					code: "page['someCustomMethod']('x');",
					filename: "/tmp/example.spec.ts",
				},
				{
					// A dynamic (non-Literal) computed key is not resolvable to a name,
					// so it is never reported — it could be anything at runtime.
					code: "obj[dynamicKey]();",
					filename: "/tmp/example.spec.ts",
				},
			],
			invalid: [],
		});
	});
});
