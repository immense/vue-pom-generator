import type { PwLocator, PwPage } from "./playwright-types";

export const POINTER_CALLOUT_IDS = {
	annotation: "__pw_pointer_callout__",
	arrow: "__pw_pointer_callout_arrow__",
	content: "__pw_pointer_callout_content__",
} as const;

export const POINTER_CALLOUT_THEME = {
	arrowPadding: 10,
	arrowSize: 14,
	avoidPadding: 12,
	background: "#dc2626",
	border: "0px solid transparent",
	borderRadius: 0,
	boxShadow: "0 20px 44px rgba(127, 29, 29, 0.32)",
	charsPerLine: 28,
	gap: 18,
	margin: 18,
	maxWidth: 320,
	minHeight: 52,
	minWidth: 180,
	textColor: "#f8fafc",
} as const;

export type ElementTarget = string | PwLocator;

export interface CalloutTargetBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ShowCalloutOptions {
	skipScroll?: boolean;
	targetBox?: CalloutTargetBox;
}

export interface CalloutRenderRequest {
	overlayIds: string[];
	target: ElementTarget;
	targetBox: CalloutTargetBox;
	text: string;
}

export interface CalloutRenderer {
	readonly overlayIds?: string[];
	hide: (page: PwPage) => Promise<void>;
	show: (page: PwPage, request: CalloutRenderRequest) => Promise<void>;
}

export interface CalloutOptions {
	extraOverlayIds?: string[];
	renderer?: CalloutRenderer;
}

export function measureCalloutBubble(text: string): { bubbleHeight: number; bubbleWidth: number } {
	return {
		bubbleWidth: Math.min(
			POINTER_CALLOUT_THEME.maxWidth,
			Math.max(
				POINTER_CALLOUT_THEME.minWidth,
				Math.min(text.length, POINTER_CALLOUT_THEME.charsPerLine) * 7 + 44,
			),
		),
		bubbleHeight: Math.max(
			POINTER_CALLOUT_THEME.minHeight,
			Math.ceil(Math.max(text.length, 1) / POINTER_CALLOUT_THEME.charsPerLine) * 20 + 24,
		),
	};
}

async function __pw_ensure_simple_callout__(page: PwPage): Promise<void> {
	await page.evaluate(
		({
			annotationId,
			contentId,
			background,
			border,
			borderRadius,
			boxShadow,
			textColor,
		}: {
			annotationId: string;
			contentId: string;
			background: string;
			border: string;
			borderRadius: number;
			boxShadow: string;
			textColor: string;
		}) => {
			const ensureElement = <T extends HTMLElement>(id: string, tagName: keyof HTMLElementTagNameMap): T => {
				const existing = document.getElementById(id);
				if (existing instanceof HTMLElement) {
					return existing as T;
				}
				const created = document.createElement(tagName);
				created.id = id;
				return created as T;
			};

			const annotation = ensureElement<HTMLDivElement>(annotationId, "div");
			annotation.setAttribute(
				"style",
				[
					"position:fixed",
					"z-index:2147483647",
					"pointer-events:none",
					"left:18px",
					"top:18px",
					"width:220px",
					"box-sizing:border-box",
					"padding:12px 16px",
					"border:" + border,
					"border-radius:" + borderRadius + "px",
					"background:" + background,
					"color:" + textColor,
					"font:600 13px/1.45 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
					"letter-spacing:0.01em",
					"box-shadow:" + boxShadow,
					"opacity:0",
					"white-space:normal",
					"transform:translate3d(0,0,0)",
					"transform-origin:center",
				].join(";"),
			);

			const content = ensureElement<HTMLDivElement>(contentId, "div");
			content.setAttribute("style", "position:relative;z-index:1;");

			if (!annotation.isConnected) {
				document.body.appendChild(annotation);
			}
			if (content.parentElement !== annotation) {
				annotation.appendChild(content);
			}
		},
		{
			annotationId: POINTER_CALLOUT_IDS.annotation,
			contentId: POINTER_CALLOUT_IDS.content,
			background: POINTER_CALLOUT_THEME.background,
			border: POINTER_CALLOUT_THEME.border,
			borderRadius: POINTER_CALLOUT_THEME.borderRadius,
			boxShadow: POINTER_CALLOUT_THEME.boxShadow,
			textColor: POINTER_CALLOUT_THEME.textColor,
		},
	);
}

const __pw_default_callout_renderer__: CalloutRenderer = {
	overlayIds: [
		POINTER_CALLOUT_IDS.annotation,
		POINTER_CALLOUT_IDS.content,
		POINTER_CALLOUT_IDS.arrow,
	],
	async hide(page) {
		await page.evaluate(
			({ annotationId, contentId, arrowId }: { annotationId: string; contentId: string; arrowId: string }) => {
				const annotation = document.getElementById(annotationId) as HTMLDivElement | null;
				const content = document.getElementById(contentId) as HTMLDivElement | null;
				const arrow = document.getElementById(arrowId) as HTMLDivElement | null;
				if (!annotation) {
					return;
				}

				if (content) {
					content.textContent = "";
				}

				annotation.style.transition = "opacity 120ms ease-in-out, transform 160ms ease-in-out";
				annotation.style.opacity = "0";
				annotation.style.transform = "scale(0.96)";
				annotation.setAttribute("data-placement", "hidden");
				if (arrow) {
					arrow.style.opacity = "0";
					arrow.style.left = "";
					arrow.style.top = "";
					arrow.style.right = "";
					arrow.style.bottom = "";
				}
			},
			{
				annotationId: POINTER_CALLOUT_IDS.annotation,
				contentId: POINTER_CALLOUT_IDS.content,
				arrowId: POINTER_CALLOUT_IDS.arrow,
			},
		);
	},
	async show(page, request) {
		await __pw_ensure_simple_callout__(page);
		const { bubbleHeight, bubbleWidth } = measureCalloutBubble(request.text);
		await page.evaluate(
			({
				annotationId,
				contentId,
				arrowId,
				bubbleHeight,
				bubbleWidth,
				border,
				borderRadius,
				background,
				gap,
				text,
				targetBox,
				margin,
			}: {
				annotationId: string;
				contentId: string;
				arrowId: string;
				bubbleHeight: number;
				bubbleWidth: number;
				border: string;
				borderRadius: number;
				background: string;
				gap: number;
				text: string;
				targetBox: CalloutTargetBox;
				margin: number;
			}) => {
				const annotation = document.getElementById(annotationId) as HTMLDivElement | null;
				const content = document.getElementById(contentId) as HTMLDivElement | null;
				const arrow = document.getElementById(arrowId) as HTMLDivElement | null;
				if (!annotation || !content) {
					return;
				}

				const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth, 1280);
				const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight, 720);
				const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
				const targetCenterX = targetBox.x + targetBox.width / 2;
				const targetCenterY = targetBox.y + targetBox.height / 2;
				const maxX = Math.max(margin, viewportWidth - bubbleWidth - margin);
				const maxY = Math.max(margin, viewportHeight - bubbleHeight - margin);
				const candidates = [
					{
						placement: "right",
						x: targetBox.x + targetBox.width + gap,
						y: targetCenterY - bubbleHeight / 2,
					},
					{
						placement: "bottom",
						x: targetCenterX - bubbleWidth / 2,
						y: targetBox.y + targetBox.height + gap,
					},
					{
						placement: "left",
						x: targetBox.x - bubbleWidth - gap,
						y: targetCenterY - bubbleHeight / 2,
					},
					{
						placement: "top",
						x: targetCenterX - bubbleWidth / 2,
						y: targetBox.y - bubbleHeight - gap,
					},
				] as const;

				let placement = "center";
				let resolvedX = clamp(targetCenterX - bubbleWidth / 2, margin, maxX);
				let resolvedY = clamp(targetCenterY - bubbleHeight / 2, margin, maxY);

				for (const candidate of candidates) {
					const clampedX = clamp(candidate.x, margin, maxX);
					const clampedY = clamp(candidate.y, margin, maxY);
					const fitsWithoutShift = Math.abs(clampedX - candidate.x) < 1 && Math.abs(clampedY - candidate.y) < 1;
					if (fitsWithoutShift) {
						placement = candidate.placement;
						resolvedX = candidate.x;
						resolvedY = candidate.y;
						break;
					}
				}

				content.textContent = text;
				annotation.style.width = `${bubbleWidth}px`;
				annotation.style.minHeight = `${bubbleHeight}px`;
				annotation.style.background = background;
				annotation.style.border = border;
				annotation.style.borderRadius = `${borderRadius}px`;
				annotation.style.transition = "opacity 120ms ease-in-out, transform 160ms ease-in-out";
				annotation.style.willChange = "left, top, opacity, transform";
				annotation.style.left = `${Math.round(resolvedX)}px`;
				annotation.style.top = `${Math.round(resolvedY)}px`;
				annotation.style.opacity = "1";
				annotation.style.transform = "scale(1)";
				annotation.setAttribute("data-placement", placement);
				if (arrow) {
					arrow.style.opacity = "0";
					arrow.style.left = "";
					arrow.style.top = "";
					arrow.style.right = "";
					arrow.style.bottom = "";
				}
			},
			{
				annotationId: POINTER_CALLOUT_IDS.annotation,
				contentId: POINTER_CALLOUT_IDS.content,
				arrowId: POINTER_CALLOUT_IDS.arrow,
				bubbleHeight,
				bubbleWidth,
				border: POINTER_CALLOUT_THEME.border,
				borderRadius: POINTER_CALLOUT_THEME.borderRadius,
				background: POINTER_CALLOUT_THEME.background,
				gap: POINTER_CALLOUT_THEME.gap,
				text: request.text,
				targetBox: request.targetBox,
				margin: POINTER_CALLOUT_THEME.margin,
			},
		);
	},
};

export const simpleCalloutRenderer = __pw_default_callout_renderer__;

export class Callout {
	private readonly page: PwPage;
	private readonly extraOverlayIds: string[];
	private readonly renderer: CalloutRenderer;

	public constructor(page: PwPage, options?: CalloutOptions) {
		this.page = page;
		this.extraOverlayIds = options?.extraOverlayIds ?? [];
		this.renderer = options?.renderer ?? __pw_default_callout_renderer__;
	}

	private toLocator(target: ElementTarget): PwLocator {
		return typeof target === "string" ? this.page.locator(target) : target;
	}

	public async hide(): Promise<void> {
		await this.renderer.hide(this.page);
	}

	public async showForElement(
		target: ElementTarget,
		annotationText: string,
		options?: ShowCalloutOptions,
	): Promise<void> {
		const text = annotationText.trim();
		if (!text) {
			await this.hide();
			return;
		}

		const locator = this.toLocator(target);
		if (!options?.skipScroll) {
			try {
				await locator.first().scrollIntoViewIfNeeded();
			}
			catch {
				// Element may detach during navigation; the bounding-box lookup will surface the failure.
			}
		}

		const targetBox = options?.targetBox ?? await locator.first().boundingBox();
		if (!targetBox) {
			throw new Error("Callout.showForElement: target has no bounding box");
		}

		const overlayIds = Array.from(new Set([
			...(this.renderer.overlayIds ?? []),
			...this.extraOverlayIds,
		]));

		await this.renderer.show(this.page, {
			overlayIds,
			target,
			targetBox: {
				height: targetBox.height,
				width: targetBox.width,
				x: targetBox.x,
				y: targetBox.y,
			},
			text,
		});
	}
}
