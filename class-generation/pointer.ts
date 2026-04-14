import { Callout, type CalloutOptions, type ElementTarget } from "./callout";
import type { PwLocator, PwPage } from "./playwright-types";

const __PW_POINTER_ID__ = "__pw_pointer__";
const __PW_EDITABLE_DESCENDANT_SELECTOR__
	= "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable]:not([contenteditable='false'])";

// A minimal 16×24 arrow pointer encoded as a base64 PNG.
const __PW_POINTER_PNG__ =
	"data:image/png;base64,"
	+ "iVBORw0KGgoAAAANSUhEUgAAABQAAAAeCAQAAACGG/bgAAAAAmJLR0QA/4ePzL8AAAAJcEhZcwAA"
	+ "HsYAAB7GAZEt8iwAAAAHdElNRQfgAwgMIwdxU/i7AAABZklEQVQ4y43TsU4UURSH8W+XmYwkS2I0"
	+ "9CRKpKGhsvIJjG9giQmliHFZlkUIGnEF7KTiCagpsYHWhoTQaiUUxLixYZb5KAAZZhbunu7O/PKf"
	+ "e+fcA+/pqwb4DuximEqXhT4iI8dMpBWEsWsuGYdpZFttiLSSgTvhZ1W/SvfO1CvYdV1kPghV68a3"
	+ "0zzUWZH5pBqEui7dnqlFmLoq0gxC1XfGZdoLal2kea8ahLoqKXNAJQBT2yJzwUTVt0bS6ANqy1ga"
	+ "VCEq/oVTtjji4hQVhhnlYBH4WIJV9vlkXLm+10R8oJb79Jl1j9UdazJRGpkrmNkSF9SOz2T71s7M"
	+ "SIfD2lmmfjGSRz3hK8l4w1P+bah/HJLN0sys2JSMZQB+jKo6KSc8vLlLn5ikzF4268Wg2+pPOWW6"
	+ "ONcpr3PrXy9VfS473M/D7H+TLmrqsXtOGctvxvMv2oVNP+Av0uHbzbxyJaywyUjx8TlnPY2YxqkD"
	+ "dAAAAABJRU5ErkJggg==";

const __pw_pointer_positions__ = new WeakMap<object, { x: number; y: number }>();

function __pw_get_pointer_pos__(page: PwPage): { x: number; y: number } {
	return __pw_pointer_positions__.get(page as object) ?? { x: 0, y: 0 };
}

function __pw_set_pointer_pos__(page: PwPage, x: number, y: number): void {
	__pw_pointer_positions__.set(page as object, { x, y });
}

export interface PointerMoveRequest {
	animate: boolean;
	durationMilliseconds: number;
	endX: number;
	endY: number;
	startX: number;
	startY: number;
	transitionStyle: string;
}

export interface PointerPressRequest {
	durationMilliseconds: number;
}

export interface PointerRenderer {
	readonly overlayIds?: string[];
	ensure: (page: PwPage) => Promise<void>;
	move: (page: PwPage, request: PointerMoveRequest) => Promise<void>;
	press: (page: PwPage, request: PointerPressRequest) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Animation options
// ---------------------------------------------------------------------------

export interface PlaywrightAnimationOptions {
	/**
	 * Set to false to disable all animations and delays. Clicks/fills still happen.
	 * Default: true
	 */
	enabled?: boolean;

	/**
	 * Extra delay (ms) added before every action on top of per-action delays.
	 * Default: 0
	 */
	extraDelayMs?: number;

	/** Visual pointer-movement configuration. */
	pointer?: {
		/**
		 * Duration of the CSS-transition pointer glide in ms.
		 * Set to 0 to teleport the pointer without animation.
		 * Default: 250
		 */
		durationMilliseconds?: number;

		/**
		 * CSS transition timing function for the pointer glide.
		 * Default: "ease-in-out"
		 */
		transitionStyle?: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";

		/**
		 * Delay (ms) passed to element.click({ delay }) for a realistic press.
		 * Default: 0
		 */
		clickDelayMilliseconds?: number;
	};

	/** Keyboard / typing configuration. */
	keyboard?: {
		/**
		 * Delay between keystrokes in ms – makes typing visible on screen / in video.
		 * Default: 100
		 */
		typeDelayMilliseconds?: number;
	};
}

let animationOptions: PlaywrightAnimationOptions = {
	enabled: true,
	extraDelayMs: 0,
	pointer: { durationMilliseconds: 250, transitionStyle: "ease-in-out", clickDelayMilliseconds: 0 },
	keyboard: { typeDelayMilliseconds: 100 },
};

export function setPlaywrightAnimationOptions(options: PlaywrightAnimationOptions): void {
	animationOptions = {
		enabled: options?.enabled ?? true,
		extraDelayMs: options?.extraDelayMs ?? 0,
		pointer: {
			durationMilliseconds: options?.pointer?.durationMilliseconds ?? 250,
			transitionStyle: options?.pointer?.transitionStyle ?? "ease-in-out",
			clickDelayMilliseconds: options?.pointer?.clickDelayMilliseconds ?? 0,
		},
		keyboard: {
			typeDelayMilliseconds: options?.keyboard?.typeDelayMilliseconds ?? 100,
		},
	};
}

export interface AfterPointerClickInfo {
	/** Resolved test id from the clicked element (if present). */
	testId?: string;

	/**
	 * Whether the click should be considered "instrumented".
	 * BasePage uses this flag to decide whether to wait for the injected click event.
	 */
	instrumented: boolean;
}

export type AfterPointerClick = (info: AfterPointerClickInfo) => void | Promise<void>;

const __pw_default_pointer_renderer__: PointerRenderer = {
	overlayIds: [__PW_POINTER_ID__],
	async ensure(page) {
		const exists = await page.evaluate(
			({ pointerId }: { pointerId: string }) => document.getElementById(pointerId) != null,
			{ pointerId: __PW_POINTER_ID__ },
		);
		if (exists) return;

		__pw_set_pointer_pos__(page, 0, 0);

		await page.evaluate(
			({ id, src }: { id: string; src: string }) => {
				const img = document.createElement("img");
				img.setAttribute("src", src);
				img.setAttribute("id", id);
				img.setAttribute(
					"style",
					"position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;transform-origin:0 0;",
				);
				document.body.appendChild(img);
			},
			{
				id: __PW_POINTER_ID__,
				src: __PW_POINTER_PNG__,
			},
		);
	},
	async move(page, request) {
		await page.evaluate(
			({
				animate,
				dur,
				ex,
				ey,
				id,
				style,
				sx,
				sy,
			}: {
				animate: boolean;
				dur: number;
				ex: number;
				ey: number;
				id: string;
				style: string;
				sx: number;
				sy: number;
			}) => {
				const el = document.getElementById(id);
				if (!el) {
					return;
				}

				el.style.transition = "";
				el.style.willChange = "left, top";
				el.style.left = `${animate ? sx : ex}px`;
				el.style.top = `${animate ? sy : ey}px`;

				if (animate) {
					void el.offsetWidth;
					el.style.transition = `left ${dur}ms ${style}, top ${dur}ms ${style}`;
					el.style.left = `${ex}px`;
					el.style.top = `${ey}px`;
				}
			},
			{
				animate: request.animate,
				dur: request.durationMilliseconds,
				ex: request.endX,
				ey: request.endY,
				id: __PW_POINTER_ID__,
				style: request.transitionStyle,
				sx: request.startX,
				sy: request.startY,
			},
		);
	},
	async press(page, request) {
		await page.evaluate(
			({ id, dur }: { id: string; dur: number }) => {
				const el = document.getElementById(id);
				if (el) {
					el.style.transition = `transform ${dur}ms`;
					el.style.transform = "scale(0.6)";
					setTimeout(() => {
						el.style.transition = `transform ${dur}ms`;
						el.style.transform = "scale(1)";
					}, dur);
				}
			},
			{ id: __PW_POINTER_ID__, dur: request.durationMilliseconds },
		);
	},
};

// ---------------------------------------------------------------------------
// Pointer class
// ---------------------------------------------------------------------------

export class Pointer {
	private readonly page: PwPage;
	private readonly testIdAttribute: string;
	private readonly callout: Callout;
	private readonly renderer: PointerRenderer;

	public constructor(page: PwPage, testIdAttribute: string, callout?: Callout, renderer?: PointerRenderer) {
		this.page = page;
		this.testIdAttribute = (testIdAttribute ?? "data-testid").trim() || "data-testid";
		this.renderer = renderer ?? __pw_default_pointer_renderer__;
		const calloutOptions: CalloutOptions = {
			extraOverlayIds: this.renderer.overlayIds,
		};
		this.callout = callout ?? new Callout(page, calloutOptions);
	}

	private toLocator(target: ElementTarget): PwLocator {
		return typeof target === "string" ? this.page.locator(target) : target;
	}

	private async getTestId(locator: PwLocator): Promise<string | undefined> {
		const raw = await locator.first().getAttribute(this.testIdAttribute);
		const trimmed = (raw ?? "").trim();
		return trimmed || undefined;
	}

	private async isEditableElement(locator: PwLocator): Promise<boolean> {
		try {
			return await locator.first().evaluate((element) => {
				if (!(element instanceof HTMLElement)) {
					return false;
				}

				const tagName = element.tagName.toLowerCase();
				return tagName === "input"
					|| tagName === "textarea"
					|| tagName === "select"
					|| element.isContentEditable;
			});
		}
		catch {
			return false;
		}
	}

	private async resolveEditableLocator(locator: PwLocator): Promise<PwLocator> {
		const first = locator.first();
		if (await this.isEditableElement(first)) {
			return first;
		}

		const descendant = first.locator(__PW_EDITABLE_DESCENDANT_SELECTOR__).first();
		try {
			if (await descendant.count() > 0) {
				return descendant;
			}
		}
		catch {
			// Fall back to the original target if descendant lookup fails.
		}

		return first;
	}

	public async animateCursorToElement(
		target: ElementTarget,
		executeClick: boolean = true,
		delayMs: number = 1000,
		annotationText: string = "",
		options?: {
			afterClick?: AfterPointerClick;
		},
	): Promise<void> {
		const locator = this.toLocator(target);
		const trimmedAnnotationText = annotationText.trim();

		try {
			await locator.first().scrollIntoViewIfNeeded();
		}
		catch {
			// Element may detach during navigation; let the subsequent action surface the error.
		}

		const opts = animationOptions;
		const animEnabled = opts.enabled !== false;

		if (!animEnabled) {
			if (trimmedAnnotationText) {
				await this.callout.showForElement(locator, trimmedAnnotationText);
			}
			else {
				await this.callout.hide();
			}

			// Fast path: no animations.
			const extraDelay = Math.max(0, opts.extraDelayMs ?? 0);
			if (extraDelay > 0) await this.page.waitForTimeout(extraDelay);

			let clickedTestId: string | undefined;
			if (executeClick) {
				try { clickedTestId = await this.getTestId(locator); } catch { /* noop */ }
				await locator.first().click({ force: true });
			}
			if (options?.afterClick) {
				await options.afterClick({ testId: clickedTestId, instrumented: Boolean(clickedTestId) });
			}
			return;
		}

		// --- Animated path ---
		const moveDurationMs = opts.pointer?.durationMilliseconds ?? 250;
		const transitionStyle = opts.pointer?.transitionStyle ?? "ease-in-out";
		const clickDelayMs = opts.pointer?.clickDelayMilliseconds ?? 0;
		const extraDelayMs = Math.max(0, opts.extraDelayMs ?? 0);
		const actionDelayMs = Math.max(0, delayMs);

		// Inject the visual pointer if it doesn't exist yet.
		await this.renderer.ensure(this.page);

		// Move the pointer to the target element.
		const box = await locator.first().boundingBox();
		if (box) {
			const endX = box.x + box.width / 2;
			const endY = box.y + box.height / 2;
			const { x: startX, y: startY } = __pw_get_pointer_pos__(this.page);
			const distance = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);

			const shouldAnimate = moveDurationMs > 0 && distance > 0;
			await this.renderer.move(this.page, {
				animate: shouldAnimate,
				durationMilliseconds: moveDurationMs,
				endX,
				endY,
				startX,
				startY,
				transitionStyle,
			});

			if (trimmedAnnotationText) {
				await this.callout.showForElement(locator, trimmedAnnotationText, {
					skipScroll: true,
					targetBox: box,
				});
			}
			else {
				await this.callout.hide();
			}

			if (shouldAnimate) {
				// Wait for the animation to finish.
				await this.page.waitForTimeout(moveDurationMs + 25);
			}

			__pw_set_pointer_pos__(this.page, endX, endY);
		}
		else {
			await this.callout.hide();
		}

		// Apply action delay + extra delay.
		const totalDelay = actionDelayMs + extraDelayMs;
		if (totalDelay > 0) await this.page.waitForTimeout(totalDelay);

		let clickedTestId: string | undefined;
		if (executeClick) {
			// Brief scale-down "press" animation on the pointer image.
			if (moveDurationMs > 0) {
				const pressDur = Math.max(80, Math.round(moveDurationMs / 3));
				await this.renderer.press(this.page, { durationMilliseconds: pressDur });
			}

			try { clickedTestId = await this.getTestId(locator); } catch { /* noop */ }
			await locator.first().click({ delay: clickDelayMs, force: true });
		}

		if (options?.afterClick) {
			await options.afterClick({ testId: clickedTestId, instrumented: Boolean(clickedTestId) });
		}
	}

	public async animateCursorToElementAndClickAndFill(
		target: ElementTarget,
		text: string,
		executeClick: boolean = true,
		delayMs: number = 1000,
		annotationText: string = "",
		options?: {
			afterClick?: AfterPointerClick;
		},
	): Promise<void> {
		// Animate the pointer + click first.
		await this.animateCursorToElement(target, executeClick, delayMs, annotationText, options);

		const locator = this.toLocator(target);
		const editableLocator = await this.resolveEditableLocator(locator);
		const typeDelayMs = animationOptions.keyboard?.typeDelayMilliseconds ?? 100;

		if (animationOptions.enabled !== false && typeDelayMs > 0) {
			// Clear existing content, then type character-by-character so keystrokes are visible.
			await editableLocator.clear();
			await this.page.keyboard.type(text, { delay: typeDelayMs });
		}
		else {
			await editableLocator.fill(text);
		}
	}
}
