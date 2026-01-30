import type { Locator as PwLocator, Page as PwPage } from "@playwright/test";

export interface PlaywrightAnimationOptions {
	/**
	 * When false, cursor animations are disabled (but clicks/fills still happen).
	 *
	 * Default: true
	 */
	enabled?: boolean;

	/**
	 * Extra delay in ms before performing the action.
	 *
	 * Default: 0
	 */
	extraDelayMs?: number;
}

let animationOptions: PlaywrightAnimationOptions = { enabled: true, extraDelayMs: 0 };

export function setPlaywrightAnimationOptions(options: PlaywrightAnimationOptions): void {
	animationOptions = {
		enabled: options?.enabled ?? true,
		extraDelayMs: options?.extraDelayMs ?? 0,
	};
}

export interface AfterPointerClickInfo {
	/**
	 * Resolved test id from the clicked element (if present).
	 */
	testId?: string;

	/**
	 * Whether the click should be considered “instrumented”.
	 *
	 * BasePage uses this flag to decide whether to wait for the injected click event.
	 */
	instrumented: boolean;
}

export type AfterPointerClick = (info: AfterPointerClickInfo) => void | Promise<void>;

type ElementTarget = string | PwLocator;

export class Pointer {
	private readonly page: PwPage;
	private readonly testIdAttribute: string;

	public constructor(page: PwPage, testIdAttribute: string) {
		this.page = page;
		this.testIdAttribute = (testIdAttribute ?? "data-testid").trim() || "data-testid";
	}

	private toLocator(target: ElementTarget): PwLocator {
		return typeof target === "string" ? this.page.locator(target) : target;
	}

	private async getTestId(locator: PwLocator): Promise<string | undefined> {
		const raw = await locator.first().getAttribute(this.testIdAttribute);
		const trimmed = (raw ?? "").trim();
		return trimmed ? trimmed : undefined;
	}

	public async animateCursorToElement(
		target: ElementTarget,
		executeClick: boolean = true,
		delayMs: number = 100,
		_annotationText: string = "",
		options?: {
			afterClick?: AfterPointerClick;
		},
	): Promise<void> {
		const locator = this.toLocator(target);

		// Best-effort “animation”: make sure the element is scrolled into view and add a delay.
		try {
			await locator.first().scrollIntoViewIfNeeded();
		}
		catch {
			// If the element detaches during navigation, let the subsequent click/fill surface the error.
		}

		const totalDelay = Math.max(0, delayMs) + Math.max(0, animationOptions.extraDelayMs ?? 0);
		if (animationOptions.enabled !== false && totalDelay > 0) {
			await this.page.waitForTimeout(totalDelay);
		}

		let clickedTestId: string | undefined;
		if (executeClick) {
			try {
				clickedTestId = await this.getTestId(locator);
			}
			catch {
				clickedTestId = undefined;
			}
			await locator.first().click({ force: true });
		}

		if (options?.afterClick) {
			await options.afterClick({
				testId: clickedTestId,
				instrumented: Boolean(clickedTestId),
			});
		}
	}

	public async animateCursorToElementAndClickAndFill(
		target: ElementTarget,
		text: string,
		executeClick: boolean = true,
		delayMs: number = 100,
		annotationText: string = "",
		options?: {
			afterClick?: AfterPointerClick;
		},
	): Promise<void> {
		// Reuse the click flow so the afterClick callback observes the click.
		await this.animateCursorToElement(target, executeClick, delayMs, annotationText, options);

		const locator = this.toLocator(target);
		await locator.first().fill(text);
	}
}
