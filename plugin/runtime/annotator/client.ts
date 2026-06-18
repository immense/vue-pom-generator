import { arrow, autoPlacement, autoUpdate, computePosition, offset, shift, type Placement } from "@floating-ui/dom";

import { formatAnnotations, formatSingleAnnotationPreview, type FormattedAnnotation, type OutputDetail } from "./format";
import { ANNOTATOR_ROOT_ATTR, ANNOTATOR_STYLES } from "./styles";
import { resolveVueComponentInfo, type VueDetectorOptions } from "./vue-detector";

export interface AnnotatorClientOptions extends VueDetectorOptions {
  outputDetail: OutputDetail;
  copyToClipboard: boolean;
  showComponentTree: boolean;
}

interface AnnotatorSettings {
  outputDetail: OutputDetail;
  copyToClipboard: boolean;
  showComponentTree: boolean;
}

interface AnnotationRecord extends FormattedAnnotation {
  id: string;
  pageX: number;
  pageY: number;
}

const SETTINGS_STORAGE_KEY = "vpg-annotator-settings";
const ANNOTATIONS_STORAGE_KEY = "vpg-annotator-annotations";
const TOOLBAR_POSITION_STORAGE_KEY = "vpg-annotator-toolbar-position";
const RUNTIME_GUARD = "__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__";

type RuntimeWindow = Window & {
  [RUNTIME_GUARD]?: AnnotatorRuntime;
};

interface ToolbarPosition {
  left: number;
  top: number;
}

interface ButtonOptions {
  primary?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

type ToolbarIconName = "drag" | "inspect" | "preview" | "copy" | "clear" | "settings";

const TOOLBAR_ICON_MARKUP: Record<ToolbarIconName, string> = {
  drag: '<svg viewBox="0 0 16 16"><path d="M5 3h1v1H5zM10 3h1v1h-1zM5 7h1v1H5zM10 7h1v1h-1zM5 11h1v1H5zM10 11h1v1h-1z" fill="currentColor" stroke="none" /></svg>',
  inspect: '<svg viewBox="0 0 16 16"><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"/><circle cx="8" cy="8" r="2.5"/></svg>',
  preview: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z"/><circle cx="8" cy="8" r="1.8"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><path d="M6 2.5h6.5v9H6z"/><path d="M3.5 5.5H5v6.5h5.5v1.5h-7z"/></svg>',
  clear: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11"/><path d="M6 2.5h4"/><path d="M5 4.5v8"/><path d="M8 4.5v8"/><path d="M11 4.5v8"/><path d="M4 4.5h8l-.6 9H4.6z"/></svg>',
  settings: '<svg viewBox="0 0 16 16"><path d="M8 2.2l1 .6 1.2-.2.8 1 .9.7-.3 1.2.5 1-.5 1 .3 1.2-.9.7-.8 1-1.2-.2-1 .6-1-.6-1.2.2-.8-1-.9-.7.3-1.2-.5-1 .5-1-.3-1.2.9-.7.8-1 1.2.2z"/><circle cx="8" cy="8" r="2.2"/></svg>',
};

const SHORTCUT_LABELS = {
  select: "S",
  preview: "P",
  copy: "C",
  clear: "X",
  settings: ",",
  cancel: "Esc",
} as const;

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function formatShortcutTitle(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

function isInsideAnnotatorTree(node: EventTarget | null): boolean {
  return node instanceof Element && !!node.closest(`[${ANNOTATOR_ROOT_ATTR}]`);
}

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) {
    return false;
  }

  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
    return true;
  }

  return node.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

function getElementSummary(element: Element): string {
  const testId = element.getAttribute("data-testid");
  if (testId) {
    return `[data-testid="${testId}"]`;
  }

  const id = element.getAttribute("id");
  if (id) {
    return `${element.tagName.toLowerCase()}#${id}`;
  }

  const classes = Array.from(element.classList).slice(0, 2).join(".");
  return classes ? `${element.tagName.toLowerCase()}.${classes}` : element.tagName.toLowerCase();
}

function getElementPath(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && current !== document.body && depth < 8) {
    const summary = getElementSummary(current);
    segments.unshift(summary);
    current = current.parentElement;
    depth += 1;
  }

  return segments.join(" > ");
}

function getNearbyText(element: Element): string | undefined {
  const ownText = normalizeText(element.textContent || undefined);
  if (ownText && ownText.length >= 2) {
    return ownText.length > 160 ? `${ownText.slice(0, 160)}...` : ownText;
  }

  const parentText = normalizeText(element.parentElement?.textContent || undefined);
  if (parentText) {
    return parentText.length > 160 ? `${parentText.slice(0, 160)}...` : parentText;
  }

  return undefined;
}

function getNearbyLocator(element: Element): string | undefined {
  const testId = element.getAttribute("data-testid") || element.getAttribute("data-v-pom-testid");
  if (testId) {
    return `near \`[data-testid="${testId}"]\``;
  }

  const siblings = Array.from(element.parentElement?.children || [])
    .filter(sibling => sibling !== element)
    .slice(0, 3)
    .map(getElementSummary);

  return siblings.length ? `near ${siblings.map(value => `\`${value}\``).join(", ")}` : undefined;
}

function createFloatingArrow(): HTMLDivElement {
  const arrowEl = document.createElement("div");
  arrowEl.className = "vpg-annotator-arrow";
  arrowEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");
  return arrowEl;
}

function toCssPixels(value: number): string {
  return `${Math.round(value)}px`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createButtonBase(label: string, onClick: () => void, options: ButtonOptions = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vpg-annotator-btn${options.primary ? " vpg-annotator-btn--primary" : ""}`;
  button.setAttribute(ANNOTATOR_ROOT_ATTR, "");
  button.setAttribute("aria-label", label);
  button.title = formatShortcutTitle(label, options.shortcut);
  if (options.shortcut) {
    button.setAttribute("aria-keyshortcuts", options.shortcut);
  }
  if (options.pressed) {
    button.setAttribute("aria-pressed", "true");
  }
  if (options.disabled) {
    button.disabled = true;
  }
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createIcon(iconName: ToolbarIconName): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "vpg-annotator-icon";
  icon.setAttribute(ANNOTATOR_ROOT_ATTR, "");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = TOOLBAR_ICON_MARKUP[iconName];
  return icon;
}

function createButton(label: string, onClick: () => void, options: ButtonOptions = {}): HTMLButtonElement {
  const button = createButtonBase(label, onClick, options);
  button.textContent = label;
  return button;
}

function createIconButton(
  label: string,
  iconName: ToolbarIconName,
  onClick: () => void,
  options: ButtonOptions = {},
): HTMLButtonElement {
  const button = createButtonBase(label, onClick, options);
  button.classList.add("vpg-annotator-btn--icon");
  button.appendChild(createIcon(iconName));
  return button;
}

function createToolbarHandle(): HTMLDivElement {
  const handle = document.createElement("div");
  handle.className = "vpg-annotator-toolbar-handle";
  handle.setAttribute(ANNOTATOR_ROOT_ATTR, "");
  handle.setAttribute("title", "Drag annotator toolbar");
  handle.setAttribute("aria-hidden", "true");
  handle.appendChild(createIcon("drag"));
  return handle;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard copy failed.");
  }
}

class AnnotatorRuntime {
  private readonly options: AnnotatorClientOptions;
  private readonly settings: AnnotatorSettings;
  private annotations: AnnotationRecord[] = [];
  private hoveredElement: Element | null = null;
  private inspectMode = false;
  private pendingAnnotation: AnnotationRecord | null = null;
  private editingAnnotationId: string | null = null;
  private toolbarEl!: HTMLDivElement;
  private markerLayerEl!: HTMLDivElement;
  private panelLayerEl!: HTMLDivElement;
  private highlightEl!: HTMLDivElement;
  private highlightLabelEl!: HTMLDivElement;
  private shieldEl!: HTMLDivElement;
  private toastEl: HTMLDivElement | null = null;
  private previewButton: HTMLButtonElement | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  private currentPanelCleanup: (() => void) | null = null;
  private currentPanelEl: HTMLElement | null = null;
  private toastTimer: number | null = null;
  private toolbarPosition: ToolbarPosition | null = null;

  constructor(options: AnnotatorClientOptions) {
    this.options = options;
    this.settings = this.loadSettings();
    this.annotations = this.loadAnnotations();
    this.toolbarPosition = this.loadToolbarPosition();
  }

  mount() {
    this.ensureStyles();
    this.createChrome();
    this.renderToolbar();
    this.renderMarkers();
    this.attachGlobalListeners();
  }

  private ensureStyles() {
    if (document.getElementById("vpg-annotator-styles")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "vpg-annotator-styles";
    style.textContent = ANNOTATOR_STYLES;
    document.head.appendChild(style);
  }

  private createChrome() {
    this.toolbarEl = document.createElement("div");
    this.toolbarEl.className = "vpg-annotator-toolbar";
    this.toolbarEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");

    this.markerLayerEl = document.createElement("div");
    this.markerLayerEl.className = "vpg-annotator-layer vpg-annotator-layer--markers";
    this.markerLayerEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");

    this.panelLayerEl = document.createElement("div");
    this.panelLayerEl.className = "vpg-annotator-layer vpg-annotator-layer--panels";
    this.panelLayerEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");

    this.highlightEl = document.createElement("div");
    this.highlightEl.className = "vpg-annotator-highlight";
    this.highlightEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    this.highlightEl.hidden = true;

    this.highlightLabelEl = document.createElement("div");
    this.highlightLabelEl.className = "vpg-annotator-highlight-label";
    this.highlightLabelEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    this.highlightEl.appendChild(this.highlightLabelEl);
    this.panelLayerEl.appendChild(this.highlightEl);

    this.shieldEl = document.createElement("div");
    this.shieldEl.className = "vpg-annotator-shield";
    this.shieldEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    this.shieldEl.hidden = true;

    document.body.append(this.markerLayerEl, this.panelLayerEl, this.shieldEl, this.toolbarEl);
  }

  private renderToolbar() {
    this.toolbarEl.replaceChildren();

    const handle = createToolbarHandle();
    this.attachToolbarDrag(handle);

    const count = document.createElement("span");
    count.className = "vpg-annotator-count vpg-annotator-subtle";
    count.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    count.textContent = `${this.annotations.length} annotation${this.annotations.length === 1 ? "" : "s"}`;

    const selectButton = createIconButton(this.inspectMode ? "Stop selecting" : "Select element", "inspect", () => {
      this.setInspectMode(!this.inspectMode);
    }, { primary: this.inspectMode, pressed: this.inspectMode, shortcut: SHORTCUT_LABELS.select });

    const previewButton = createIconButton("Preview annotations", "preview", () => this.openPreview(), {
      disabled: this.annotations.length === 0,
      shortcut: SHORTCUT_LABELS.preview,
    });
    this.previewButton = previewButton;

    const copyButton = createIconButton("Copy annotations", "copy", () => this.copyAnnotations(), {
      disabled: this.annotations.length === 0,
      shortcut: SHORTCUT_LABELS.copy,
    });

    const clearButton = createIconButton("Clear annotations", "clear", () => this.clearAnnotations(), {
      disabled: this.annotations.length === 0,
      shortcut: SHORTCUT_LABELS.clear,
    });

    const settingsButton = createIconButton("Annotator settings", "settings", () => this.openSettings(), {
      shortcut: SHORTCUT_LABELS.settings,
    });
    this.settingsButton = settingsButton;

    this.toolbarEl.append(handle, selectButton, previewButton, copyButton, clearButton, settingsButton, count);
    this.applyToolbarPosition();
  }

  private renderMarkers() {
    this.markerLayerEl.replaceChildren();
    for (const [index, annotation] of this.annotations.entries()) {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "vpg-annotator-marker";
      marker.setAttribute(ANNOTATOR_ROOT_ATTR, "");
      marker.textContent = String(index + 1);
      marker.style.left = toCssPixels(annotation.pageX);
      marker.style.top = toCssPixels(annotation.pageY - window.scrollY);
      marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openInputForExistingAnnotation(annotation, marker);
      });
      this.markerLayerEl.appendChild(marker);
    }
  }

  private attachGlobalListeners() {
    this.shieldEl.addEventListener("mousemove", (event) => this.onShieldMouseMove(event));
    this.shieldEl.addEventListener("click", (event) => this.onShieldClick(event));
    window.addEventListener("scroll", () => this.renderMarkers(), true);
    window.addEventListener("resize", () => {
      this.renderMarkers();
      this.applyToolbarPosition();
    });
    window.addEventListener("keydown", (event) => this.onWindowKeyDown(event), true);
  }

  private loadSettings(): AnnotatorSettings {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Partial<AnnotatorSettings> : {};
      return {
        outputDetail: parsed.outputDetail ?? this.options.outputDetail,
        copyToClipboard: parsed.copyToClipboard ?? this.options.copyToClipboard,
        showComponentTree: parsed.showComponentTree ?? this.options.showComponentTree,
      };
    }
    catch {
      return {
        outputDetail: this.options.outputDetail,
        copyToClipboard: this.options.copyToClipboard,
        showComponentTree: this.options.showComponentTree,
      };
    }
  }

  private saveSettings() {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.settings));
    this.renderToolbar();
  }

  private loadAnnotations(): AnnotationRecord[] {
    try {
      const raw = sessionStorage.getItem(ANNOTATIONS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as Record<string, AnnotationRecord[]> | AnnotationRecord[];
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return Array.isArray(parsed[window.location.href]) ? parsed[window.location.href]! : [];
    }
    catch {
      return [];
    }
  }

  private saveAnnotations() {
    const store = { [window.location.href]: this.annotations };
    sessionStorage.setItem(ANNOTATIONS_STORAGE_KEY, JSON.stringify(store));
    this.renderToolbar();
    this.renderMarkers();
  }

  private loadToolbarPosition(): ToolbarPosition | null {
    try {
      const raw = localStorage.getItem(TOOLBAR_POSITION_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<ToolbarPosition>;
      if (typeof parsed.left !== "number" || typeof parsed.top !== "number") {
        return null;
      }
      return { left: parsed.left, top: parsed.top };
    }
    catch {
      return null;
    }
  }

  private saveToolbarPosition() {
    try {
      if (!this.toolbarPosition) {
        localStorage.removeItem(TOOLBAR_POSITION_STORAGE_KEY);
        return;
      }
      localStorage.setItem(TOOLBAR_POSITION_STORAGE_KEY, JSON.stringify(this.toolbarPosition));
    }
    catch {
      // Ignore storage failures and keep the current in-memory position.
    }
  }

  private clampToolbarPosition(position: ToolbarPosition): ToolbarPosition {
    const margin = 12;
    const width = this.toolbarEl.offsetWidth || 0;
    const height = this.toolbarEl.offsetHeight || 0;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    return {
      left: clamp(position.left, margin, maxLeft),
      top: clamp(position.top, margin, maxTop),
    };
  }

  private applyToolbarPosition() {
    if (!this.toolbarPosition) {
      this.toolbarEl.style.left = "";
      this.toolbarEl.style.top = "";
      this.toolbarEl.style.right = "";
      this.toolbarEl.style.bottom = "";
      return;
    }

    const position = this.clampToolbarPosition(this.toolbarPosition);
    this.toolbarPosition = position;
    this.toolbarEl.style.left = toCssPixels(position.left);
    this.toolbarEl.style.top = toCssPixels(position.top);
    this.toolbarEl.style.right = "auto";
    this.toolbarEl.style.bottom = "auto";
  }

  private attachToolbarDrag(handle: HTMLElement) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const rect = this.toolbarEl.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      this.toolbarEl.classList.add("vpg-annotator-toolbar--dragging");

      const onPointerMove = (moveEvent: PointerEvent) => {
        this.toolbarPosition = {
          left: startLeft + moveEvent.clientX - startX,
          top: startTop + moveEvent.clientY - startY,
        };
        this.applyToolbarPosition();
      };

      const onPointerUp = () => {
        this.toolbarEl.classList.remove("vpg-annotator-toolbar--dragging");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        this.saveToolbarPosition();
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    });
  }

  private onWindowKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (event.key === "Escape") {
      if (!this.inspectMode && !this.currentPanelEl) {
        return;
      }
      event.preventDefault();
      if (this.inspectMode) {
        this.setInspectMode(false);
      }
      else {
        this.closePanel();
      }
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === SHORTCUT_LABELS.select.toLowerCase()) {
      event.preventDefault();
      this.setInspectMode(!this.inspectMode);
      return;
    }

    if (key === SHORTCUT_LABELS.preview.toLowerCase()) {
      if (!this.annotations.length) {
        return;
      }
      event.preventDefault();
      this.openPreview();
      return;
    }

    if (key === SHORTCUT_LABELS.copy.toLowerCase()) {
      if (!this.annotations.length) {
        return;
      }
      event.preventDefault();
      void this.copyAnnotations();
      return;
    }

    if (key === SHORTCUT_LABELS.clear.toLowerCase()) {
      if (!this.annotations.length) {
        return;
      }
      event.preventDefault();
      this.clearAnnotations();
      return;
    }

    if (event.key === SHORTCUT_LABELS.settings) {
      event.preventDefault();
      this.openSettings();
    }
  }

  private setInspectMode(next: boolean) {
    this.inspectMode = next;
    this.shieldEl.hidden = !next;
    this.highlightEl.hidden = !next;
    if (!next) {
      this.hoveredElement = null;
      this.highlightEl.hidden = true;
    }
    this.closePanel();
    this.renderToolbar();
  }

  private stopInspectModePreservingPending() {
    this.inspectMode = false;
    this.shieldEl.hidden = true;
    this.highlightEl.hidden = true;
    this.hoveredElement = null;
    this.renderToolbar();
  }

  private elementFromPoint(clientX: number, clientY: number): Element | null {
    const previousPointerEvents = this.shieldEl.style.pointerEvents;
    this.shieldEl.style.pointerEvents = "none";
    const elements = document.elementsFromPoint(clientX, clientY);
    this.shieldEl.style.pointerEvents = previousPointerEvents;
    return elements.find(element => !isInsideAnnotatorTree(element)) ?? null;
  }

  private onShieldMouseMove(event: MouseEvent) {
    if (!this.inspectMode) {
      return;
    }

    const element = this.elementFromPoint(event.clientX, event.clientY);
    if (!element) {
      this.hoveredElement = null;
      this.highlightEl.hidden = true;
      return;
    }

    this.hoveredElement = element;
    const rect = element.getBoundingClientRect();
    const info = resolveVueComponentInfo(element, this.options);
    Object.assign(this.highlightEl.style, {
      left: toCssPixels(rect.left),
      top: toCssPixels(rect.top),
      width: toCssPixels(rect.width),
      height: toCssPixels(rect.height),
    });
    this.highlightLabelEl.textContent = info?.formatted || getElementSummary(element);
    this.highlightEl.hidden = false;
  }

  private onShieldClick(event: MouseEvent) {
    if (!this.inspectMode) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const element = this.elementFromPoint(event.clientX, event.clientY);
    if (!element) {
      return;
    }

    this.hoveredElement = element;
    this.pendingAnnotation = this.buildAnnotationDraft(element, "");
    this.editingAnnotationId = null;
    this.stopInspectModePreservingPending();
    this.openInputForDraft(element);
  }

  private buildAnnotationDraft(element: Element, comment: string): AnnotationRecord {
    const rect = element.getBoundingClientRect();
    const componentInfo = resolveVueComponentInfo(element, this.options);
    return {
      id: `draft-${Date.now()}`,
      comment,
      component: this.settings.showComponentTree ? componentInfo?.component : undefined,
      source: componentInfo?.source,
      targetLabel: componentInfo?.component || getElementSummary(element),
      uiText: getNearbyText(element),
      locator: getNearbyLocator(element),
      domHint: getElementPath(element),
      pageX: rect.left + rect.width / 2,
      pageY: rect.top + window.scrollY,
    };
  }

  private createPanelBase(className: string) {
    const panel = document.createElement("div");
    panel.className = className;
    panel.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    const arrowEl = createFloatingArrow();
    const body = document.createElement("div");
    body.className = className === "vpg-annotator-settings" ? "vpg-annotator-settings-body" : className === "vpg-annotator-input" ? "vpg-annotator-input-body" : "vpg-annotator-panel-body";
    body.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    panel.append(arrowEl, body);
    document.body.appendChild(panel);
    return { panel, arrowEl, body };
  }

  private attachFloating(reference: Element, panel: HTMLElement, arrowEl: HTMLElement, placement: Placement, allowedPlacements: readonly Placement[]) {
    const cleanup = autoUpdate(reference, panel, async () => {
      const result = await computePosition(reference, panel, {
        strategy: "fixed",
        placement,
        middleware: [
          offset(14),
          autoPlacement({ allowedPlacements: [...allowedPlacements], padding: 12 }),
          shift({ padding: 12 }),
          arrow({ element: arrowEl, padding: 10 }),
        ],
      });

      panel.setAttribute("data-placement", result.placement);
      panel.style.left = toCssPixels(result.x);
      panel.style.top = toCssPixels(result.y);
      panel.style.visibility = "visible";

      const arrowData = result.middlewareData.arrow;
      const side = result.placement.split("-")[0];
      const staticSide = side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
      arrowEl.style.removeProperty("top");
      arrowEl.style.removeProperty("right");
      arrowEl.style.removeProperty("bottom");
      arrowEl.style.removeProperty("left");
      if (typeof arrowData?.x === "number") {
        arrowEl.style.left = toCssPixels(arrowData.x);
      }
      if (typeof arrowData?.y === "number") {
        arrowEl.style.top = toCssPixels(arrowData.y);
      }
      arrowEl.style.setProperty(staticSide, "-7px");
    });

    return cleanup;
  }

  private openInputForDraft(reference: Element) {
    if (!this.pendingAnnotation) {
      return;
    }

    const { panel, body, arrowEl } = this.createPanelBase("vpg-annotator-input");
    const title = document.createElement("div");
    title.className = "vpg-annotator-heading";
    title.textContent = this.pendingAnnotation.component || this.pendingAnnotation.targetLabel;

    const subtitle = document.createElement("p");
    subtitle.className = "vpg-annotator-subtle";
    subtitle.textContent = this.pendingAnnotation.source || "Unable to find component file path.";

    const metadata = document.createElement("textarea");
    metadata.className = "vpg-annotator-textarea vpg-annotator-input-meta";
    metadata.readOnly = true;
    metadata.value = formatSingleAnnotationPreview(this.pendingAnnotation, this.settings.outputDetail, window.location.href);

    const commentLabel = document.createElement("label");
    commentLabel.className = "vpg-annotator-label";
    commentLabel.textContent = "Comment";

    const comment = document.createElement("textarea");
    comment.className = "vpg-annotator-comment";
    comment.value = this.pendingAnnotation.comment;
    comment.placeholder = "Add a comment...";

    const actions = document.createElement("div");
    actions.className = "vpg-annotator-actions";
    const cancelButton = createButton("Cancel", () => this.closePanel());
    const saveButton = createButton(this.editingAnnotationId ? "Save" : "Add", () => {
      if (!this.pendingAnnotation) {
        return;
      }
      this.pendingAnnotation.comment = comment.value.trim();
      if (this.editingAnnotationId) {
        const index = this.annotations.findIndex(annotation => annotation.id === this.editingAnnotationId);
        if (index >= 0) {
          this.annotations[index] = { ...this.pendingAnnotation, id: this.editingAnnotationId };
        }
      }
      else {
        this.annotations.push({ ...this.pendingAnnotation, id: `annotation-${Date.now()}` });
      }
      this.saveAnnotations();
      this.closePanel();
    }, { primary: true });

    actions.append(cancelButton);
    if (this.editingAnnotationId) {
      const deleteButton = createButton("Delete", () => {
        this.annotations = this.annotations.filter(annotation => annotation.id !== this.editingAnnotationId);
        this.saveAnnotations();
        this.closePanel();
      });
      actions.append(deleteButton);
    }
    actions.append(saveButton);

    body.append(title, subtitle, metadata, commentLabel, comment, actions);

    this.showPanel(panel, () => this.attachFloating(reference, panel, arrowEl, "right-start", ["right-start", "left-start", "bottom-start", "top-start"]));
    comment.focus();
  }

  private openInputForExistingAnnotation(annotation: AnnotationRecord, reference: Element) {
    this.pendingAnnotation = { ...annotation };
    this.editingAnnotationId = annotation.id;
    this.openInputForDraft(reference);
  }

  private openPreview() {
    if (!this.previewButton || this.annotations.length === 0) {
      return;
    }

    const { panel, body, arrowEl } = this.createPanelBase("vpg-annotator-panel");
    const title = document.createElement("div");
    title.className = "vpg-annotator-heading";
    title.textContent = "Annotation preview";
    const subtitle = document.createElement("p");
    subtitle.className = "vpg-annotator-subtle";
    subtitle.textContent = "Exact text that Copy will copy.";
    const textarea = document.createElement("textarea");
    textarea.className = "vpg-annotator-textarea";
    textarea.readOnly = true;
    textarea.value = formatAnnotations(this.annotations, this.settings.outputDetail, window.location.href);
    body.append(title, subtitle, textarea);

    this.showPanel(panel, () => this.attachFloating(this.previewButton!, panel, arrowEl, "top-start", ["top-start", "left-start", "top-end", "left-end"]));
  }

  private openSettings() {
    if (!this.settingsButton) {
      return;
    }

    const { panel, body, arrowEl } = this.createPanelBase("vpg-annotator-settings");
    const title = document.createElement("div");
    title.className = "vpg-annotator-heading";
    title.textContent = "Annotator settings";

    const detailField = document.createElement("div");
    detailField.className = "vpg-annotator-field";
    const detailLabel = document.createElement("label");
    detailLabel.className = "vpg-annotator-label";
    detailLabel.textContent = "Output detail";
    const detailSelect = document.createElement("select");
    detailSelect.className = "vpg-annotator-select";
    detailSelect.innerHTML = '<option value="standard">Standard</option><option value="forensic">Forensic</option>';
    detailSelect.value = this.settings.outputDetail;
    detailSelect.addEventListener("change", () => {
      this.settings.outputDetail = detailSelect.value === "forensic" ? "forensic" : "standard";
      this.saveSettings();
    });
    detailField.append(detailLabel, detailSelect);

    const showComponentField = document.createElement("label");
    showComponentField.className = "vpg-annotator-row";
    const showComponentCopy = document.createElement("span");
    showComponentCopy.className = "vpg-annotator-label";
    showComponentCopy.textContent = "Show component labels";
    const showComponentCheckbox = document.createElement("input");
    showComponentCheckbox.type = "checkbox";
    showComponentCheckbox.className = "vpg-annotator-checkbox";
    showComponentCheckbox.checked = this.settings.showComponentTree;
    showComponentCheckbox.addEventListener("change", () => {
      this.settings.showComponentTree = showComponentCheckbox.checked;
      this.saveSettings();
    });
    showComponentField.append(showComponentCopy, showComponentCheckbox);

    const shortcutsField = document.createElement("div");
    shortcutsField.className = "vpg-annotator-field";
    const shortcutsLabel = document.createElement("div");
    shortcutsLabel.className = "vpg-annotator-label";
    shortcutsLabel.textContent = "Keyboard shortcuts";
    const shortcutsList = document.createElement("div");
    shortcutsList.className = "vpg-annotator-shortcuts";

    for (const [shortcut, description] of [
      [SHORTCUT_LABELS.select, "Toggle selection mode"],
      [SHORTCUT_LABELS.preview, "Open preview"],
      [SHORTCUT_LABELS.copy, "Copy annotations"],
      [SHORTCUT_LABELS.clear, "Clear annotations"],
      [SHORTCUT_LABELS.settings, "Open settings"],
      [SHORTCUT_LABELS.cancel, "Close panel / cancel selection"],
    ] as const) {
      const row = document.createElement("div");
      row.className = "vpg-annotator-shortcut-row";
      const text = document.createElement("span");
      text.className = "vpg-annotator-subtle";
      text.textContent = description;
      const kbd = document.createElement("kbd");
      kbd.className = "vpg-annotator-kbd";
      kbd.setAttribute(ANNOTATOR_ROOT_ATTR, "");
      kbd.textContent = shortcut;
      row.append(text, kbd);
      shortcutsList.appendChild(row);
    }

    shortcutsField.append(shortcutsLabel, shortcutsList);

    body.append(title, detailField, showComponentField, shortcutsField);
    this.showPanel(panel, () => this.attachFloating(this.settingsButton!, panel, arrowEl, "top-start", ["top-start", "left-start", "top-end", "left-end"]));
  }

  private disposeCurrentPanel() {
    this.currentPanelCleanup?.();
    this.currentPanelCleanup = null;
    this.currentPanelEl?.remove();
    this.currentPanelEl = null;
  }

  private showPanel(panel: HTMLElement, attachFloatingFn: () => () => void) {
    this.disposeCurrentPanel();
    this.currentPanelEl = panel;
    this.currentPanelCleanup = attachFloatingFn();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (isInsideAnnotatorTree(target)) {
        return;
      }
      this.closePanel();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    const originalCleanup = this.currentPanelCleanup;
    this.currentPanelCleanup = () => {
      originalCleanup?.();
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }

  private closePanel() {
    this.disposeCurrentPanel();
    this.pendingAnnotation = null;
    this.editingAnnotationId = null;
  }

  private clearAnnotations() {
    if (!this.annotations.length) {
      return;
    }
    this.annotations = [];
    this.saveAnnotations();
    this.showToast("Annotations cleared");
    this.closePanel();
  }

  private async copyAnnotations() {
    if (!this.annotations.length) {
      return;
    }

    const text = formatAnnotations(this.annotations, this.settings.outputDetail, window.location.href);

    try {
      await copyTextToClipboard(text);
      this.showToast("Copied");
    }
    catch {
      this.showToast("Copy failed");
    }
  }

  private showToast(message: string) {
    this.toastEl?.remove();
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    const toast = document.createElement("div");
    toast.className = "vpg-annotator-toast";
    toast.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    toast.textContent = message;
    document.body.appendChild(toast);
    this.toastEl = toast;
    this.toastTimer = window.setTimeout(() => {
      toast.remove();
      if (this.toastEl === toast) {
        this.toastEl = null;
      }
      this.toastTimer = null;
    }, 1600);
  }
}

export function mountAnnotatorClient(options: AnnotatorClientOptions) {
  const runtimeWindow = window as RuntimeWindow;
  if (runtimeWindow[RUNTIME_GUARD]) {
    return runtimeWindow[RUNTIME_GUARD]!;
  }

  const runtime = new AnnotatorRuntime(options);
  runtime.mount();
  runtimeWindow[RUNTIME_GUARD] = runtime;
  return runtime;
}
