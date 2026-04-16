import { arrow, autoPlacement, computePosition, limitShift, offset, shift } from "./floating-ui";
import {
	POINTER_CALLOUT_IDS,
	POINTER_CALLOUT_THEME,
	type CalloutRenderer,
	type CalloutTargetBox,
	measureCalloutBubble,
} from "./callout";
import type { PwPage } from "./playwright-types";

const __PW_POINTER_CALLOUT_AVOID_SELECTOR__
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

const __PW_POINTER_ALLOWED_PLACEMENTS__: Placement[] = [
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

const __PW_POINTER_ORDERED_PLACEMENTS__ = Object.fromEntries(
	__PW_POINTER_ALLOWED_PLACEMENTS__.map(placement => [
		placement,
		[
			placement,
			...__PW_POINTER_ALLOWED_PLACEMENTS__.filter(candidate => candidate !== placement),
		],
	]),
) as Record<Placement, Placement[]>;

interface CalloutContext {
	avoidRects: CalloutTargetBox[];
	preferredPosition?: CalloutPositionResult;
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

interface CalloutPositionResult {
	adjustmentDistance: number;
	arrowX: number | null;
	arrowY: number | null;
	placement: Placement;
	x: number;
	y: number;
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

function __pw_finalize_callout_position__(
	referenceRect: CalloutTargetBox,
	floatingRect: CalloutTargetBox,
	protectedRects: CalloutTargetBox[],
	viewportWidth: number,
	viewportHeight: number,
	resolvedPlacement: Placement,
	rawX: number,
	rawY: number,
	baseArrowData?: { x?: number; y?: number },
): CalloutPositionResult {
	const { side } = __pw_parse_placement__(resolvedPlacement);
	let x = Math.round(rawX);
	let y = Math.round(rawY);
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
		Math.max(x, POINTER_CALLOUT_THEME.margin),
		Math.max(POINTER_CALLOUT_THEME.margin, viewportWidth - floatingRect.width - POINTER_CALLOUT_THEME.margin),
	);
	y = Math.min(
		Math.max(y, POINTER_CALLOUT_THEME.margin),
		Math.max(POINTER_CALLOUT_THEME.margin, viewportHeight - floatingRect.height - POINTER_CALLOUT_THEME.margin),
	);
	const adjustmentDistance = Math.abs(x - baseX) + Math.abs(y - baseY);
	const referenceCenterX = referenceRect.x + referenceRect.width / 2;
	const referenceCenterY = referenceRect.y + referenceRect.height / 2;
	const arrowHalf = POINTER_CALLOUT_THEME.arrowSize / 2;
	const arrowX = side === "top" || side === "bottom"
		? !layoutAdjustedForProtectedRect && typeof baseArrowData?.x === "number"
			? Math.round(baseArrowData.x)
			: Math.min(
				Math.max(referenceCenterX - x - arrowHalf, POINTER_CALLOUT_THEME.arrowPadding),
				Math.max(POINTER_CALLOUT_THEME.arrowPadding, floatingRect.width - POINTER_CALLOUT_THEME.arrowSize - POINTER_CALLOUT_THEME.arrowPadding),
			)
		: null;
	const arrowY = side === "left" || side === "right"
		? !layoutAdjustedForProtectedRect && typeof baseArrowData?.y === "number"
			? Math.round(baseArrowData.y)
			: Math.min(
				Math.max(referenceCenterY - y - arrowHalf, POINTER_CALLOUT_THEME.arrowPadding),
				Math.max(POINTER_CALLOUT_THEME.arrowPadding, floatingRect.height - POINTER_CALLOUT_THEME.arrowSize - POINTER_CALLOUT_THEME.arrowPadding),
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

async function __pw_compute_shifted_position__(
	referenceRect: CalloutTargetBox,
	floatingRect: CalloutTargetBox,
	placement: Placement,
	protectedRects: CalloutTargetBox[],
	viewportWidth: number,
	viewportHeight: number,
): Promise<CalloutPositionResult> {
	const platform = __pw_create_platform__(viewportWidth, viewportHeight);
	const floatingElement = __pw_create_virtual_element__(floatingRect, "floating");
	const referenceElement = __pw_create_virtual_element__(referenceRect, "reference");
	const arrowElement = __pw_create_virtual_element__(
		{ x: 0, y: 0, width: POINTER_CALLOUT_THEME.arrowSize, height: POINTER_CALLOUT_THEME.arrowSize },
		"arrow",
	);
	const result = await computePosition(referenceElement, floatingElement, {
		middleware: [
			offset(POINTER_CALLOUT_THEME.gap),
			shift({
				limiter: limitShift({}),
				padding: POINTER_CALLOUT_THEME.margin,
			}),
			arrow({
				element: arrowElement,
				padding: POINTER_CALLOUT_THEME.arrowPadding,
			}),
		],
		placement,
		platform,
		strategy: "fixed",
	});
	return __pw_finalize_callout_position__(
		referenceRect,
		floatingRect,
		protectedRects,
		viewportWidth,
		viewportHeight,
		result.placement as Placement,
		result.x,
		result.y,
		(result.middlewareData as { arrow?: { x?: number; y?: number } }).arrow,
	);
}

async function __pw_compute_callout_layout__(
	targetRect: CalloutTargetBox,
	floatingRect: CalloutTargetBox,
	context: CalloutContext,
): Promise<CalloutLayout> {
	const referenceRect = targetRect;
	let bestLayout: (CalloutLayout & { score: number }) | null = null;
	const orderedPlacements = context.preferredPosition
		? __PW_POINTER_ORDERED_PLACEMENTS__[context.preferredPosition.placement]
		: __PW_POINTER_ALLOWED_PLACEMENTS__;

	for (const placement of orderedPlacements) {
		const result = context.preferredPosition && placement === context.preferredPosition.placement
			? context.preferredPosition
			: await __pw_compute_shifted_position__(
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
			(sum, avoidRect) => sum + __pw_overlap_area__(positionedRect, __pw_expand_rect__(avoidRect, POINTER_CALLOUT_THEME.avoidPadding)),
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

async function __pw_get_preferred_callout_position__(
	targetRect: CalloutTargetBox,
	floatingRect: CalloutTargetBox,
	protectedRects: CalloutTargetBox[],
	viewportWidth: number,
	viewportHeight: number,
): Promise<CalloutPositionResult> {
	const platform = __pw_create_platform__(viewportWidth, viewportHeight);
	const floatingElement = __pw_create_virtual_element__(floatingRect, "floating");
	const referenceElement = __pw_create_virtual_element__(targetRect, "reference");
	const arrowElement = __pw_create_virtual_element__(
		{ x: 0, y: 0, width: POINTER_CALLOUT_THEME.arrowSize, height: POINTER_CALLOUT_THEME.arrowSize },
		"arrow",
	);
	const result = await computePosition(referenceElement, floatingElement, {
		middleware: [
			offset(POINTER_CALLOUT_THEME.gap),
			autoPlacement({
				allowedPlacements: __PW_POINTER_ALLOWED_PLACEMENTS__,
				padding: POINTER_CALLOUT_THEME.margin,
			}),
			shift({
				limiter: limitShift({}),
				padding: POINTER_CALLOUT_THEME.margin,
			}),
			arrow({
				element: arrowElement,
				padding: POINTER_CALLOUT_THEME.arrowPadding,
			}),
		],
		placement: "top",
		platform,
		strategy: "fixed",
	});
	return __pw_finalize_callout_position__(
		targetRect,
		floatingRect,
		protectedRects,
		viewportWidth,
		viewportHeight,
		result.placement as Placement,
		result.x,
		result.y,
		(result.middlewareData as { arrow?: { x?: number; y?: number } }).arrow,
	);
}

async function __pw_ensure_floating_ui_callout__(page: PwPage): Promise<void> {
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
					"isolation:isolate",
				].join(";"),
			);

			const contentEl = ensureElement<HTMLDivElement>(contentId, "div");
			contentEl.setAttribute("style", "position:relative;z-index:1;");

			const arrowEl = ensureElement<HTMLDivElement>(arrowId, "div");
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

			if (!annotation.isConnected) {
				document.body.appendChild(annotation);
			}
			if (contentEl.parentElement !== annotation) {
				annotation.appendChild(contentEl);
			}
			if (arrowEl.parentElement !== annotation) {
				annotation.appendChild(arrowEl);
			}
		},
		{
			annotationId: POINTER_CALLOUT_IDS.annotation,
			contentId: POINTER_CALLOUT_IDS.content,
			arrowId: POINTER_CALLOUT_IDS.arrow,
			arrowSize: POINTER_CALLOUT_THEME.arrowSize,
			background: POINTER_CALLOUT_THEME.background,
			border: POINTER_CALLOUT_THEME.border,
			borderRadius: POINTER_CALLOUT_THEME.borderRadius,
			boxShadow: POINTER_CALLOUT_THEME.boxShadow,
			textColor: POINTER_CALLOUT_THEME.textColor,
		},
	);
}

export const floatingUiCalloutRenderer: CalloutRenderer = {
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
		await __pw_ensure_floating_ui_callout__(page);
		const { bubbleHeight, bubbleWidth } = measureCalloutBubble(request.text);
		const context = await page.evaluate(
			({
				avoidSelector,
				ex,
				ey,
				overlayIds,
			}: {
				avoidSelector: string;
				ex: number;
				ey: number;
				overlayIds: string[];
			}) => {
				type BrowserRect = { x: number; y: number; width: number; height: number };

				const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
				const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth, 1280);
				const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight, 720);
				const viewportArea = viewportWidth * viewportHeight;
				const overlayIdSet = new Set(overlayIds);

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
						.filter((candidate) => !overlayIdSet.has(candidate.id))
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
				avoidSelector: __PW_POINTER_CALLOUT_AVOID_SELECTOR__,
				ex: request.targetBox.x + request.targetBox.width / 2,
				ey: request.targetBox.y + request.targetBox.height / 2,
				overlayIds: request.overlayIds,
			},
		);
		const preferredPosition = await __pw_get_preferred_callout_position__(
			{ x: request.targetBox.x, y: request.targetBox.y, width: request.targetBox.width, height: request.targetBox.height },
			{ x: 0, y: 0, width: bubbleWidth, height: bubbleHeight },
			context.protectedTargetRects,
			context.viewportWidth,
			context.viewportHeight,
		);
		const layout = await __pw_compute_callout_layout__(
			{ x: request.targetBox.x, y: request.targetBox.y, width: request.targetBox.width, height: request.targetBox.height },
			{ x: 0, y: 0, width: bubbleWidth, height: bubbleHeight },
			{
				...context,
				preferredPosition,
			},
		);
		await page.evaluate(
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
				layout: CalloutLayout;
				text: string;
			}) => {
				const annotation = document.getElementById(annotationId) as HTMLDivElement | null;
				const content = document.getElementById(contentId) as HTMLDivElement | null;
				const arrow = document.getElementById(arrowId) as HTMLDivElement | null;
				if (!annotation || !content || !arrow) {
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
				annotation.style.left = `${layout.x}px`;
				annotation.style.top = `${layout.y}px`;
				annotation.style.opacity = "1";
				annotation.style.transform = "scale(1)";
				annotation.setAttribute("data-placement", layout.placement);

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
			},
			{
				annotationId: POINTER_CALLOUT_IDS.annotation,
				arrowId: POINTER_CALLOUT_IDS.arrow,
				arrowSize: POINTER_CALLOUT_THEME.arrowSize,
				background: POINTER_CALLOUT_THEME.background,
				border: POINTER_CALLOUT_THEME.border,
				borderRadius: POINTER_CALLOUT_THEME.borderRadius,
				bubbleHeight,
				bubbleWidth,
				contentId: POINTER_CALLOUT_IDS.content,
				layout,
				text: request.text,
			},
		);
	},
};

export function createFloatingUiCalloutRenderer(): CalloutRenderer {
	return floatingUiCalloutRenderer;
}
