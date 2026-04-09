import type { PwLocator, PwPage } from "./playwright-types";

// ---------------------------------------------------------------------------
// Cursor visual overlay helpers
// ---------------------------------------------------------------------------

const __PW_CURSOR_ID__ = "__pw_cursor__";
const __PW_EDITABLE_DESCENDANT_SELECTOR__
	= "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable]:not([contenteditable='false'])";

// A minimal 16×24 arrow cursor encoded as a base64 PNG.
const __PW_CURSOR_PNG__ =
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

// Per-page cursor position (viewport coords). WeakMap so pages can be GC'd.
const __pw_cursor_positions__ = new WeakMap<object, { x: number; y: number }>();

function __pw_get_cursor_pos__(page: PwPage): { x: number; y: number } {
	return __pw_cursor_positions__.get(page as object) ?? { x: 0, y: 0 };
}

function __pw_set_cursor_pos__(page: PwPage, x: number, y: number): void {
	__pw_cursor_positions__.set(page as object, { x, y });
}

async function __pw_ensure_cursor__(page: PwPage): Promise<void> {
	const exists = await page.evaluate(
		(id: string) => document.getElementById(id) != null,
		__PW_CURSOR_ID__,
	);
	if (exists) return;

	// Reset tracked position for this page.
	__pw_set_cursor_pos__(page, 0, 0);

	await page.evaluate(
		({ id, src }: { id: string; src: string }) => {
			const img = document.createElement("img");
			img.setAttribute("src", src);
			img.setAttribute("id", id);
			// position:fixed keeps coordinates viewport-relative (matching Playwright boundingBox).
			img.setAttribute(
				"style",
				"position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;transform-origin:0 0;",
			);
			document.body.appendChild(img);
		},
		{ id: __PW_CURSOR_ID__, src: __PW_CURSOR_PNG__ },
	);
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

	/** Visual cursor / pointer-movement configuration. */
	pointer?: {
		/**
		 * Duration of the CSS-transition cursor glide in ms.
		 * Set to 0 to teleport the cursor without animation.
		 * Default: 250
		 */
		durationMilliseconds?: number;

		/**
		 * CSS transition timing function for the cursor glide.
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

type ElementTarget = string | PwLocator;

// ---------------------------------------------------------------------------
// Pointer class
// ---------------------------------------------------------------------------

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
		delayMs: number = 100,
		_annotationText: string = "",
		options?: {
			afterClick?: AfterPointerClick;
		},
	): Promise<void> {
		const locator = this.toLocator(target);

		try {
			await locator.first().scrollIntoViewIfNeeded();
		}
		catch {
			// Element may detach during navigation; let the subsequent action surface the error.
		}

		const opts = animationOptions;
		const animEnabled = opts.enabled !== false;

		if (!animEnabled) {
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

		// Inject the visual cursor if it doesn't exist yet.
		await __pw_ensure_cursor__(this.page);

		// Move the cursor to the target element.
		const box = await locator.first().boundingBox();
		if (box) {
			const endX = box.x + box.width / 2;
			const endY = box.y + box.height / 2;
			const { x: startX, y: startY } = __pw_get_cursor_pos__(this.page);
			const distance = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);

			if (moveDurationMs > 0 && distance > 0) {
				// Glide the cursor image using a CSS transition.
				await this.page.evaluate(
					({ id, sx, sy, ex, ey, dur, style }: {
						id: string; sx: number; sy: number; ex: number; ey: number; dur: number; style: string;
					}) => {
						const el = document.getElementById(id);
						if (!el) return;
						el.style.transition = "";
						el.style.willChange = "left, top";
						el.style.left = `${sx}px`;
						el.style.top = `${sy}px`;
						// Force reflow so the browser registers the start position before transitioning.
						void el.offsetWidth;
						el.style.transition = `left ${dur}ms ${style}, top ${dur}ms ${style}`;
						el.style.left = `${ex}px`;
						el.style.top = `${ey}px`;
					},
					{ id: __PW_CURSOR_ID__, sx: startX, sy: startY, ex: endX, ey: endY, dur: moveDurationMs, style: transitionStyle },
				);
				// Wait for the animation to finish.
				await this.page.waitForTimeout(moveDurationMs + 25);
			}
			else {
				// Teleport (distance 0 or duration 0).
				await this.page.evaluate(
					({ id, x, y }: { id: string; x: number; y: number }) => {
						const el = document.getElementById(id);
						if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
					},
					{ id: __PW_CURSOR_ID__, x: endX, y: endY },
				);
			}

			__pw_set_cursor_pos__(this.page, endX, endY);
		}

		// Apply action delay + extra delay.
		const totalDelay = actionDelayMs + extraDelayMs;
		if (totalDelay > 0) await this.page.waitForTimeout(totalDelay);

		let clickedTestId: string | undefined;
		if (executeClick) {
			// Brief scale-down "press" animation on the cursor image.
			if (moveDurationMs > 0) {
				const pressDur = Math.max(80, Math.round(moveDurationMs / 3));
				await this.page.evaluate(
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
					{ id: __PW_CURSOR_ID__, dur: pressDur },
				);
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
		delayMs: number = 100,
		annotationText: string = "",
		options?: {
			afterClick?: AfterPointerClick;
		},
	): Promise<void> {
		// Animate cursor + click first.
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
