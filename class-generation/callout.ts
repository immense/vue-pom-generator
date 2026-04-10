import { computePosition, limitShift, offset, shift } from "./floating-ui";
import type { PwLocator, PwPage } from "./playwright-types";

const __PW_CURSOR_ID__ = "__pw_cursor__";
const __PW_CURSOR_ANNOTATION_ID__ = "__pw_cursor_annotation__";
const __PW_CURSOR_ANNOTATION_CONTENT_ID__ = "__pw_cursor_annotation_content__";
const __PW_CURSOR_ANNOTATION_ARROW_ID__ = "__pw_cursor_annotation_arrow__";
const __PW_CURSOR_ANNOTATION_AVOID_SELECTOR__
	= [
		"[data-callout-avoid]",
		"button",
		"input",
		"textarea",
		"select",
		"summary",
		"a[href]",
		"[role='button']",
		"[role='link']",
		"[role='textbox']",
		"[role='combobox']",
		"[role='option']",
		"[role='tab']",
		"[role='menuitem']",
		"[contenteditable='']",
		"[contenteditable='true']",
		"[contenteditable]:not([contenteditable='false'])",
	].join(",");
const __PW_CURSOR_ANNOTATION_MARGIN__ = 18;
const __PW_CURSOR_ANNOTATION_GAP__ = 18;
const __PW_CURSOR_ANNOTATION_ARROW_SIZE__ = 14;
const __PW_CURSOR_ANNOTATION_AVOID_PADDING__ = 12;
const __PW_CURSOR_ANNOTATION_BACKGROUND__ = "#dc2626";
const __PW_CURSOR_ANNOTATION_BORDER__ = "0px solid transparent";
const __PW_CURSOR_ANNOTATION_BOX_SHADOW__ = "0 20px 44px rgba(127, 29, 29, 0.32)";
const __PW_CURSOR_ANNOTATION_TEXT_COLOR__ = "#f8fafc";
const __PW_CURSOR_ANNOTATION_RADIUS__ = 0;

type Placement =
	| "top"
	| "top-start"
	| "top-end"
	| "right"
	| "right-start"
	| "right-end"
	| "bottom"
	| "bottom-start"
	| "bottom-end"
	| "left"
	| "left-start"
	| "left-end";

const __PW_CURSOR_ALLOWED_PLACEMENTS__: Placement[] = [
	"top-start",
	"top",
	"top-end",
	"right-start",
	"right",
	"right-end",
	"bottom-start",
	"bottom",
	"bottom-end",
	"left-start",
	"left",
	"left-end",
];

export type ElementTarget = string | PwLocator;

export interface CalloutTargetBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface CalloutContext {
	avoidRects: CalloutTargetBox[];
	protectedTargetRects: CalloutTargetBox[];
	viewportHeight: number;
	viewportWidth: number;
}

interface FloatingVirtualElement extends CalloutTargetBox {
	kind: "arrow" | "floating" | "reference";
}

interface CalloutLayout {
	arrowX: number | null;
	arrowY: number | null;
	placement: Placement;
	staticSide: "bottom" | "left" | "right" | "top";
	x: number;
	y: number;
}

export interface ShowCalloutOptions {
	skipScroll?: boolean;
	targetBox?: CalloutTargetBox;
}

function __pw_overlap_area__(first: CalloutTargetBox, second: CalloutTargetBox): number {
	const horizontal = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
	const vertical = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
	return horizontal * vertical;
}

function __pw_rect_center_distance__(first: CalloutTargetBox, second: CalloutTargetBox): number {
	const firstCenterX = first.x + first.width / 2;
	const firstCenterY = first.y + first.height / 2;
	const secondCenterX = second.x + second.width / 2;
	const secondCenterY = second.y + second.height / 2;
	return Math.hypot(firstCenterX - secondCenterX, firstCenterY - secondCenterY);
}

function __pw_rect_gap__(first: CalloutTargetBox, second: CalloutTargetBox): number {
	const horizontalGap = Math.max(0, Math.max(second.x - (first.x + first.width), first.x - (second.x + second.width)));
	const verticalGap = Math.max(0, Math.max(second.y - (first.y + first.height), first.y - (second.y + second.height)));
	return Math.max(horizontalGap, verticalGap);
}

function __pw_expand_rect__(rect: CalloutTargetBox, padding: number): CalloutTargetBox {
	return {
		height: rect.height + (padding * 2),
		width: rect.width + (padding * 2),
		x: rect.x - padding,
		y: rect.y - padding,
	};
}

function __pw_parse_placement__(placement: Placement): {
	align: "center" | "end" | "start";
	side: "bottom" | "left" | "right" | "top";
} {
	const [side, align] = placement.split("-") as [Placement extends `${infer Side}-${string}` ? Side : never, "end" | "start" | undefined];
	return {
		align: align ?? "center",
		side,
	};
}

function __pw_to_client_rect__(rect: CalloutTargetBox) {
	return {
		bottom: rect.y + rect.height,
		height: rect.height,
		left: rect.x,
		right: rect.x + rect.width,
		top: rect.y,
		width: rect.width,
		x: rect.x,
		y: rect.y,
	};
}

function __pw_create_virtual_element__(rect: CalloutTargetBox, kind: FloatingVirtualElement["kind"]): FloatingVirtualElement {
	return {
		height: rect.height,
		kind,
		width: rect.width,
		x: rect.x,
		y: rect.y,
	};
}

function __pw_create_platform__(viewportWidth: number, viewportHeight: number) {
	const offsetParent = {
		clientHeight: viewportHeight,
		clientLeft: 0,
		clientTop: 0,
		clientWidth: viewportWidth,
	};

	return {
		convertOffsetParentRelativeRectToViewportRelativeRect: ({ rect }: { rect: CalloutTargetBox }) => rect,
		getClientRects: (element: FloatingVirtualElement) => [__pw_to_client_rect__(element)],
		getClippingRect: () => ({
			height: viewportHeight,
			width: viewportWidth,
			x: 0,
			y: 0,
		}),
		getDimensions: (element: FloatingVirtualElement) => ({
			height: element.height,
			width: element.width,
		}),
		getDocumentElement: () => ({
			clientHeight: viewportHeight,
			clientWidth: viewportWidth,
		}),
		getElementRects: ({
			floating,
			reference,
		}: {
			floating: FloatingVirtualElement;
			reference: FloatingVirtualElement;
			strategy: string;
		}) => ({
			floating: {
				height: floating.height,
				width: floating.width,
				x: 0,
				y: 0,
			},
			reference: {
				height: reference.height,
				width: reference.width,
				x: reference.x,
				y: reference.y,
			},
		}),
		getOffsetParent: () => offsetParent,
		getScale: () => ({ x: 1, y: 1 }),
		isElement: () => false,
		isRTL: () => false,
	};
}

async function __pw_compute_shifted_position__(
	referenceRect: CalloutTargetBox,
	floatingRect: CalloutTargetBox,
	placement: Placement,
	protectedRects: CalloutTargetBox[],
	viewportWidth: number,
	viewportHeight: number,
): Promise<{
	adjustmentDistance: number;
	arrowX: number | null;
	arrowY: number | null;
	placement: Placement;
	x: number;
	y: number;
}> {
	const platform = __pw_create_platform__(viewportWidth, viewportHeight);
	const floatingElement = __pw_create_virtual_element__(floatingRect, "floating");
	const referenceElement = __pw_create_virtual_element__(referenceRect, "reference");
	const result = await computePosition(referenceElement, floatingElement, {
		middleware: [
			offset(__PW_CURSOR_ANNOTATION_GAP__),
			shift({
				limiter: limitShift({}),
				padding: __PW_CURSOR_ANNOTATION_MARGIN__,
			}),
		],
		placement,
		platform,
		strategy: "fixed",
	});
	const resolvedPlacement = result.placement as Placement;
	const { side } = __pw_parse_placement__(resolvedPlacement);
	let x = Math.round(result.x);
	let y = Math.round(result.y);
	const baseX = x;
	const baseY = y;
	let layoutAdjustedForProtectedRect = false;

	for (const protectedRect of protectedRects) {
		const horizontalOverlap = x < protectedRect.x + protectedRect.width && x + floatingRect.width > protectedRect.x;
		const verticalOverlap = y < protectedRect.y + protectedRect.height && y + floatingRect.height > protectedRect.y;

		if ((side === "top" || side === "bottom") && horizontalOverlap) {
			if (side === "top" && verticalOverlap) {
				y = Math.min(y, protectedRect.y - floatingRect.height);
				layoutAdjustedForProtectedRect = true;
			}
			if (side === "bottom" && verticalOverlap) {
				y = Math.max(y, protectedRect.y + protectedRect.height);
				layoutAdjustedForProtectedRect = true;
			}
		}

		if ((side === "left" || side === "right") && verticalOverlap) {
			if (side === "left" && horizontalOverlap) {
				x = Math.min(x, protectedRect.x - floatingRect.width);
				layoutAdjustedForProtectedRect = true;
			}
			if (side === "right" && horizontalOverlap) {
				x = Math.max(x, protectedRect.x + protectedRect.width);
				layoutAdjustedForProtectedRect = true;
			}
		}
	}

	x = Math.min(
		Math.max(x, __PW_CURSOR_ANNOTATION_MARGIN__),
		Math.max(__PW_CURSOR_ANNOTATION_MARGIN__, viewportWidth - floatingRect.width - __PW_CURSOR_ANNOTATION_MARGIN__),
	);
	y = Math.min(
		Math.max(y, __PW_CURSOR_ANNOTATION_MARGIN__),
		Math.max(__PW_CURSOR_ANNOTATION_MARGIN__, viewportHeight - floatingRect.height - __PW_CURSOR_ANNOTATION_MARGIN__),
	);
	const adjustmentDistance = Math.abs(x - baseX) + Math.abs(y - baseY);
	const referenceCenterX = referenceRect.x + referenceRect.width / 2;
	const referenceCenterY = referenceRect.y + referenceRect.height / 2;
	const arrowPadding = 10;
	const arrowHalf = __PW_CURSOR_ANNOTATION_ARROW_SIZE__ / 2;
	const middlewareData = result.middlewareData as { arrow?: { x?: number; y?: number } };
	const baseArrowData = middlewareData.arrow;
	const arrowX = side === "top" || side === "bottom"
		? !layoutAdjustedForProtectedRect && typeof baseArrowData?.x === "number"
			? Math.round(baseArrowData.x)
			: Math.min(
				Math.max(referenceCenterX - x - arrowHalf, arrowPadding),
				Math.max(arrowPadding, floatingRect.width - __PW_CURSOR_ANNOTATION_ARROW_SIZE__ - arrowPadding),
			)
		: null;
	const arrowY = side === "left" || side === "right"
		? !layoutAdjustedForProtectedRect && typeof baseArrowData?.y === "number"
			? Math.round(baseArrowData.y)
			: Math.min(
				Math.max(referenceCenterY - y - arrowHalf, arrowPadding),
				Math.max(arrowPadding, floatingRect.height - __PW_CURSOR_ANNOTATION_ARROW_SIZE__ - arrowPadding),
			)
		: null;

	return {
		adjustmentDistance,
		arrowX,
		arrowY,
		placement: resolvedPlacement,
		x,
		y,
	};
}

async function __pw_compute_callout_layout__(
	targetRect: CalloutTargetBox,
	floatingRect: CalloutTargetBox,
	context: CalloutContext,
): Promise<CalloutLayout> {
	const referenceRect = targetRect;
	let bestLayout: (CalloutLayout & { score: number }) | null = null;

	for (const placement of __PW_CURSOR_ALLOWED_PLACEMENTS__) {
		const result = await __pw_compute_shifted_position__(
			referenceRect,
			floatingRect,
			placement,
			context.protectedTargetRects,
			context.viewportWidth,
			context.viewportHeight,
		);

		const positionedRect: CalloutTargetBox = {
			x: result.x,
			y: result.y,
			width: floatingRect.width,
			height: floatingRect.height,
		};
		const protectedOverlap = context.protectedTargetRects.reduce(
			(sum, avoidRect) => sum + __pw_overlap_area__(positionedRect, avoidRect),
			0,
		);
		const avoidOverlap = context.avoidRects.reduce(
			(sum, avoidRect) => sum + __pw_overlap_area__(positionedRect, __pw_expand_rect__(avoidRect, __PW_CURSOR_ANNOTATION_AVOID_PADDING__)),
			0,
		);
		const targetGap = __pw_rect_gap__(positionedRect, targetRect);
		const score = (protectedOverlap * 10)
			+ (avoidOverlap * 8)
			+ (result.adjustmentDistance * 60)
			+ (targetGap * 40)
			+ (__pw_rect_center_distance__(positionedRect, referenceRect) * 0.08);

		if (!bestLayout || score < bestLayout.score) {
			bestLayout = {
				arrowX: result.arrowX,
				arrowY: result.arrowY,
				placement: result.placement,
				score,
				staticSide: (() => {
					const side = __pw_parse_placement__(result.placement).side;
					if (side === "bottom") return "top";
					if (side === "left") return "right";
					if (side === "right") return "left";
					return "bottom";
				})(),
				x: result.x,
				y: result.y,
			};
		}
	}

	if (!bestLayout) {
		return {
			arrowX: null,
			arrowY: null,
			placement: "bottom",
			staticSide: "top",
			x: targetRect.x,
			y: targetRect.y,
		};
	}

	return bestLayout;
}

function __pw_get_callout_dimensions__(annotationText: string): { bubbleHeight: number; bubbleWidth: number } {
	const charsPerLine = 28;
	return {
		bubbleWidth: Math.min(320, Math.max(180, Math.min(annotationText.length, charsPerLine) * 7 + 44)),
		bubbleHeight: Math.max(52, Math.ceil(Math.max(annotationText.length, 1) / charsPerLine) * 20 + 24),
	};
}

async function __pw_ensure_callout__(page: PwPage): Promise<void> {
	const exists = await page.evaluate(
		({ contentId, annotationId, arrowId }: { contentId: string; annotationId: string; arrowId: string }) =>
			document.getElementById(annotationId) != null
				&& document.getElementById(contentId) != null
				&& document.getElementById(arrowId) != null,
		{
			arrowId: __PW_CURSOR_ANNOTATION_ARROW_ID__,
			contentId: __PW_CURSOR_ANNOTATION_CONTENT_ID__,
			annotationId: __PW_CURSOR_ANNOTATION_ID__,
		},
	);
	if (exists) return;

	await page.evaluate(
		({
			annotationId,
			contentId,
			arrowId,
			arrowSize,
			background,
			border,
			borderRadius,
			boxShadow,
			textColor,
		}: {
			annotationId: string;
			contentId: string;
			arrowId: string;
			arrowSize: number;
			background: string;
			border: string;
			borderRadius: number;
			boxShadow: string;
			textColor: string;
		}) => {
			const annotation = document.createElement("div");
			annotation.setAttribute("id", annotationId);
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
					"isolation:isolate",
				].join(";"),
			);

			const contentEl = document.createElement("div");
			contentEl.setAttribute("id", contentId);
			contentEl.setAttribute("style", "position:relative;z-index:1;");

			const arrowEl = document.createElement("div");
			arrowEl.setAttribute("id", arrowId);
			arrowEl.setAttribute(
				"style",
				[
					"position:absolute",
					"width:" + arrowSize + "px",
					"height:" + arrowSize + "px",
					"background:" + background,
					"transform:rotate(45deg)",
					"pointer-events:none",
					"left:0",
					"top:0",
					"box-shadow:0 12px 24px rgba(15,23,42,0.18)",
					"z-index:-1",
					"opacity:0",
				].join(";"),
			);

			annotation.appendChild(contentEl);
			annotation.appendChild(arrowEl);
			document.body.appendChild(annotation);
		},
		{
			annotationId: __PW_CURSOR_ANNOTATION_ID__,
			contentId: __PW_CURSOR_ANNOTATION_CONTENT_ID__,
			arrowId: __PW_CURSOR_ANNOTATION_ARROW_ID__,
			arrowSize: __PW_CURSOR_ANNOTATION_ARROW_SIZE__,
			background: __PW_CURSOR_ANNOTATION_BACKGROUND__,
			border: __PW_CURSOR_ANNOTATION_BORDER__,
			borderRadius: __PW_CURSOR_ANNOTATION_RADIUS__,
			boxShadow: __PW_CURSOR_ANNOTATION_BOX_SHADOW__,
			textColor: __PW_CURSOR_ANNOTATION_TEXT_COLOR__,
		},
	);
}

export class Callout {
	private readonly page: PwPage;

	public constructor(page: PwPage) {
		this.page = page;
	}

	private toLocator(target: ElementTarget): PwLocator {
		return typeof target === "string" ? this.page.locator(target) : target;
	}

	public async hide(): Promise<void> {
		await this.page.evaluate(
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
				annotationId: __PW_CURSOR_ANNOTATION_ID__,
				contentId: __PW_CURSOR_ANNOTATION_CONTENT_ID__,
				arrowId: __PW_CURSOR_ANNOTATION_ARROW_ID__,
			},
		);
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

		await __pw_ensure_callout__(this.page);
		const { bubbleHeight, bubbleWidth } = __pw_get_callout_dimensions__(text);
		const context = await this.page.evaluate(
			({
				annotationId,
				arrowId,
				avoidSelector,
				contentId,
				cursorId,
				ex,
				ey,
			}: {
				annotationId: string;
				arrowId: string;
				avoidSelector: string;
				contentId: string;
				cursorId: string;
				ex: number;
				ey: number;
			}) => {
				type BrowserRect = { x: number; y: number; width: number; height: number };

				const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
				const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth, 1280);
				const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight, 720);
				const viewportArea = viewportWidth * viewportHeight;
				const overlayIds = new Set([annotationId, arrowId, contentId, cursorId]);

				const toViewportRect = (candidateRect: { left: number; top: number; right: number; bottom: number } | DOMRect): BrowserRect | null => {
					const left = clamp(candidateRect.left, 0, viewportWidth);
					const top = clamp(candidateRect.top, 0, viewportHeight);
					const right = clamp(candidateRect.right, 0, viewportWidth);
					const bottom = clamp(candidateRect.bottom, 0, viewportHeight);
					const width = right - left;
					const height = bottom - top;
					if (width < 24 || height < 24) {
						return null;
					}

					return { x: left, y: top, width, height };
				};

				const pushUniqueRect = (rects: BrowserRect[], rect: BrowserRect | null) => {
					if (!rect) {
						return;
					}

					const duplicate = rects.some((existing) =>
						Math.abs(existing.x - rect.x) < 1
						&& Math.abs(existing.y - rect.y) < 1
						&& Math.abs(existing.width - rect.width) < 1
						&& Math.abs(existing.height - rect.height) < 1,
					);
					if (!duplicate) {
						rects.push(rect);
					}
				};

				const collectAvoidRects = (): BrowserRect[] =>
					Array.from(document.querySelectorAll<HTMLElement>(avoidSelector))
						.filter((candidate) => !overlayIds.has(candidate.id))
						.flatMap((candidate) => {
							const computedStyle = window.getComputedStyle(candidate);
							if (
								computedStyle.display === "none"
								|| computedStyle.visibility === "hidden"
								|| Number.parseFloat(computedStyle.opacity || "1") <= 0.05
							) {
								return [];
							}

							const normalizedRect = toViewportRect(candidate.getBoundingClientRect());
							if (!normalizedRect) {
								return [];
							}

							if (!candidate.hasAttribute("data-callout-avoid") && normalizedRect.width * normalizedRect.height > viewportArea * 0.35) {
								return [];
							}

							return [normalizedRect];
						});

				const collectProtectedTargetRects = (): BrowserRect[] => {
					const protectedRects: BrowserRect[] = [];
					if (typeof document.elementFromPoint !== "function") {
						return protectedRects;
					}

					const targetElement = document.elementFromPoint(ex, ey);
					if (!(targetElement instanceof HTMLElement)) {
						return protectedRects;
					}

					const targetRect = toViewportRect(targetElement.getBoundingClientRect());
					pushUniqueRect(protectedRects, targetRect);
					if (!targetRect) {
						return protectedRects;
					}

					const targetArea = targetRect.width * targetRect.height;
					let ancestor = targetElement.parentElement;
					while (ancestor && ancestor !== document.body) {
						const computedStyle = window.getComputedStyle(ancestor);
						if (
							computedStyle.display === "none"
							|| computedStyle.visibility === "hidden"
							|| Number.parseFloat(computedStyle.opacity || "1") <= 0.05
						) {
							ancestor = ancestor.parentElement;
							continue;
						}

						const ancestorRect = toViewportRect(ancestor.getBoundingClientRect());
						if (!ancestorRect) {
							ancestor = ancestor.parentElement;
							continue;
						}

						const ancestorArea = ancestorRect.width * ancestorRect.height;
						const clearlyBiggerThanTarget = ancestorArea >= Math.max(targetArea * 1.75, 18_000);
						const stillReasonablyLocal = ancestorArea <= viewportArea * 0.28;
						const containsTarget = ancestorRect.x <= targetRect.x
							&& ancestorRect.y <= targetRect.y
							&& ancestorRect.x + ancestorRect.width >= targetRect.x + targetRect.width
							&& ancestorRect.y + ancestorRect.height >= targetRect.y + targetRect.height;
						if (clearlyBiggerThanTarget && stillReasonablyLocal && containsTarget) {
							pushUniqueRect(protectedRects, ancestorRect);
						}

						if (protectedRects.length >= 3) {
							break;
						}

						ancestor = ancestor.parentElement;
					}

					return protectedRects;
				};

				return {
					avoidRects: collectAvoidRects(),
					protectedTargetRects: collectProtectedTargetRects(),
					viewportHeight,
					viewportWidth,
				};
			},
			{
				annotationId: __PW_CURSOR_ANNOTATION_ID__,
				arrowId: __PW_CURSOR_ANNOTATION_ARROW_ID__,
				avoidSelector: __PW_CURSOR_ANNOTATION_AVOID_SELECTOR__,
				contentId: __PW_CURSOR_ANNOTATION_CONTENT_ID__,
				cursorId: __PW_CURSOR_ID__,
				ex: targetBox.x + targetBox.width / 2,
				ey: targetBox.y + targetBox.height / 2,
			},
		);
		const layout = await __pw_compute_callout_layout__(
			{ x: targetBox.x, y: targetBox.y, width: targetBox.width, height: targetBox.height },
			{ x: 0, y: 0, width: bubbleWidth, height: bubbleHeight },
			context,
		);

		await this.page.evaluate(
			({
				annotationId,
				arrowId,
				arrowSize,
				background,
				border,
				borderRadius,
				bubbleHeight,
				bubbleWidth,
				contentId,
				fallbackX,
				fallbackY,
				layout,
				text,
			}: {
				annotationId: string;
				arrowId: string;
				arrowSize: number;
				background: string;
				border: string;
				borderRadius: number;
				bubbleHeight: number;
				bubbleWidth: number;
				contentId: string;
				fallbackX: number;
				fallbackY: number;
				layout: CalloutLayout | null;
				text: string;
			}) => {
				const annotation = document.getElementById(annotationId) as HTMLDivElement | null;
				const content = document.getElementById(contentId) as HTMLDivElement | null;
				const arrow = document.getElementById(arrowId) as HTMLDivElement | null;
				if (!annotation || !content) {
					return;
				}

				content.textContent = text;
				annotation.style.width = `${bubbleWidth}px`;
				annotation.style.minHeight = `${bubbleHeight}px`;
				annotation.style.background = background;
				annotation.style.border = border;
				annotation.style.borderRadius = `${borderRadius}px`;
				annotation.style.transition = "opacity 120ms ease-in-out, transform 160ms ease-in-out";
				annotation.style.willChange = "left, top, opacity, transform";
				annotation.style.left = `${layout?.x ?? fallbackX}px`;
				annotation.style.top = `${layout?.y ?? fallbackY}px`;
				annotation.style.opacity = "1";
				annotation.style.transform = "scale(1)";
				annotation.setAttribute("data-placement", layout?.placement ?? "hidden");

				if (arrow && layout) {
					arrow.style.left = "";
					arrow.style.top = "";
					arrow.style.right = "";
					arrow.style.bottom = "";
					arrow.style.transform = "rotate(45deg)";
					if (layout.arrowX !== null) {
						arrow.style.left = `${layout.arrowX}px`;
					}
					if (layout.arrowY !== null) {
						arrow.style.top = `${layout.arrowY}px`;
					}
					arrow.style.setProperty(layout.staticSide, `${Math.round(arrowSize / -2)}px`);
					arrow.style.opacity = "1";
				}
			},
			{
				annotationId: __PW_CURSOR_ANNOTATION_ID__,
				arrowId: __PW_CURSOR_ANNOTATION_ARROW_ID__,
				arrowSize: __PW_CURSOR_ANNOTATION_ARROW_SIZE__,
				background: __PW_CURSOR_ANNOTATION_BACKGROUND__,
				border: __PW_CURSOR_ANNOTATION_BORDER__,
				borderRadius: __PW_CURSOR_ANNOTATION_RADIUS__,
				bubbleHeight,
				bubbleWidth,
				contentId: __PW_CURSOR_ANNOTATION_CONTENT_ID__,
				fallbackX: targetBox.x + (targetBox.width / 2) + __PW_CURSOR_ANNOTATION_GAP__,
				fallbackY: targetBox.y + (targetBox.height / 2) + __PW_CURSOR_ANNOTATION_GAP__,
				layout,
				text,
			},
		);
	}
}
