import * as pwTestVideos from "playwright-test-videos";
import type {
	AfterPointerClick,
	AfterPointerClickInfo,
	PlaywrightAnimationOptions,
} from "playwright-test-videos";

export type { AfterPointerClick, AfterPointerClickInfo, PlaywrightAnimationOptions };

// NOTE: playwright-test-videos currently ships CommonJS.
// Import as a namespace and re-export the members we need.
export const Pointer = pwTestVideos.Pointer as typeof import("playwright-test-videos").Pointer;
export const setPlaywrightAnimationOptions = pwTestVideos.setPlaywrightAnimationOptions as typeof import("playwright-test-videos").setPlaywrightAnimationOptions;
