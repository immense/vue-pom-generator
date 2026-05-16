import { arrow, autoPlacement, autoUpdate, computePosition, offset, shift, type Placement } from "@floating-ui/dom";

import { formatAnnotations, formatSingleAnnotationPreview, type FormattedAnnotation, type OutputDetail } from "./format";
import { ANNOTATOR_ROOT_ATTR, ANNOTATOR_STYLES } from "./styles";
import { resolveVueComponentInfo, type VueDetectorOptions } from "./vue-detector";

interface AnnotatorClientOptions extends VueDetectorOptions {
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
const RUNTIME_GUARD = "__VUE_POM_GENERATOR_ANNOTATOR_RUNTIME__";

type RuntimeWindow = Window & {
  [RUNTIME_GUARD]?: AnnotatorRuntime;
};

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function isInsideAnnotatorTree(node: EventTarget | null): boolean {
  return node instanceof Element && !!node.closest(`[${ANNOTATOR_ROOT_ATTR}]`);
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

function createButton(label: string, onClick: () => void, options: { primary?: boolean; pressed?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vpg-annotator-btn${options.primary ? " vpg-annotator-btn--primary" : ""}`;
  button.textContent = label;
  button.setAttribute(ANNOTATOR_ROOT_ATTR, "");
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

  constructor(options: AnnotatorClientOptions) {
    this.options = options;
    this.settings = this.loadSettings();
    this.annotations = this.loadAnnotations();
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
    this.markerLayerEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    Object.assign(this.markerLayerEl.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483646",
    });

    this.panelLayerEl = document.createElement("div");
    this.panelLayerEl.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    Object.assign(this.panelLayerEl.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });

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
    const count = document.createElement("span");
    count.className = "vpg-annotator-subtle";
    count.setAttribute(ANNOTATOR_ROOT_ATTR, "");
    count.textContent = `${this.annotations.length} annotation${this.annotations.length === 1 ? "" : "s"}`;

    const selectButton = createButton(this.inspectMode ? "Inspecting" : "Select", () => {
      this.setInspectMode(!this.inspectMode);
    }, { primary: this.inspectMode, pressed: this.inspectMode });

    const previewButton = createButton("Preview", () => this.openPreview(), {
      disabled: this.annotations.length === 0,
    });
    this.previewButton = previewButton;

    const copyButton = createButton("Copy", () => this.copyAnnotations(), {
      disabled: this.annotations.length === 0 || !this.settings.copyToClipboard,
    });

    const clearButton = createButton("Clear", () => this.clearAnnotations(), {
      disabled: this.annotations.length === 0,
    });

    const settingsButton = createButton("Settings", () => this.openSettings());
    this.settingsButton = settingsButton;

    this.toolbarEl.append(selectButton, previewButton, copyButton, clearButton, settingsButton, count);
  }

  private renderMarkers() {
    this.markerLayerEl.replaceChildren();
    for (const [index, annotation] of this.annotations.entries()) {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "vpg-annotator-marker";
      marker.setAttribute(ANNOTATOR_ROOT_ATTR, "");
      marker.textContent = String(index + 1);
      marker.style.pointerEvents = "auto";
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
    window.addEventListener("resize", () => this.renderMarkers());
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
    panel.style.pointerEvents = "auto";
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
          offset(12),
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
      arrowEl.style.left = typeof arrowData?.x === "number" ? toCssPixels(arrowData.x) : "";
      arrowEl.style.top = typeof arrowData?.y === "number" ? toCssPixels(arrowData.y) : "";
      arrowEl.style.right = "";
      arrowEl.style.bottom = "";
      arrowEl.style.setProperty(staticSide, "-6px");
      if (staticSide !== "left") arrowEl.style.left = arrowEl.style.left || "";
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

    const copyField = document.createElement("label");
    copyField.className = "vpg-annotator-row";
    const copyLabel = document.createElement("span");
    copyLabel.className = "vpg-annotator-label";
    copyLabel.textContent = "Enable clipboard copy";
    const copyCheckbox = document.createElement("input");
    copyCheckbox.type = "checkbox";
    copyCheckbox.className = "vpg-annotator-checkbox";
    copyCheckbox.checked = this.settings.copyToClipboard;
    copyCheckbox.addEventListener("change", () => {
      this.settings.copyToClipboard = copyCheckbox.checked;
      this.saveSettings();
    });
    copyField.append(copyLabel, copyCheckbox);

    body.append(title, detailField, showComponentField, copyField);
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
    if (!this.annotations.length || !this.settings.copyToClipboard) {
      return;
    }
    const text = formatAnnotations(this.annotations, this.settings.outputDetail, window.location.href);
    await navigator.clipboard.writeText(text);
    this.showToast("Copied");
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
