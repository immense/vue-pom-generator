export interface VueDetectorOptions {
  sourceAttribute: string;
  metadataAttributePrefix: string;
}

interface VueInstance {
  parent?: VueInstance;
  type?: { name?: string; __name?: string; __file?: string };
  vnode?: { props?: Record<string, unknown> };
  $parent?: VueInstance;
  $options?: { name?: string; _componentTag?: string; __file?: string };
}

export interface ResolvedVueComponentInfo {
  component?: string;
  source?: string;
  formatted?: string;
}

/**
 * Matches well-known synthetic component names Vue's runtime emits that carry no
 * useful component identity (e.g. `template`, `slot`, `transition`). These come
 * from Vue's runtime registry, not source code, so a regex test is appropriate.
 *
 * @example
 * ignoredComponentNamePattern.test("template") // true
 * ignoredComponentNamePattern.test("UserCard") // false
 */
/* eslint-disable no-restricted-syntax -- matching well-known synthetic component names from Vue's runtime (not source-code parsing) */
const ignoredComponentNamePattern = /^(?:items\[\d+\]\.template|template|anonymous|slot|transition|transition-group)$/i;
/* eslint-enable no-restricted-syntax */

function getDirectVueInstances(element: Element): VueInstance[] {
  const instances: VueInstance[] = [];
  const vue2Instance = (element as Element & { __vue__?: VueInstance }).__vue__;
  const vue3Instance = (element as Element & { __vueParentComponent?: VueInstance }).__vueParentComponent;

  if (vue2Instance) {
    instances.push(vue2Instance);
  }

  if (vue3Instance && vue3Instance !== vue2Instance) {
    instances.push(vue3Instance);
  }

  return instances;
}

/**
 * Strip a trailing `:line:column` position from a component file path (e.g.
 * `src/Foo.vue:12:3` → `src/Foo.vue`). Operates on a runtime file-path string,
 * not source code.
 *
 * @example
 * stripSourcePosition("src/Foo.vue:12:3") // "src/Foo.vue"
 * stripSourcePosition("src/Foo.vue") // "src/Foo.vue"
 */
function stripSourcePosition(sourcePath: string): string {
  /* eslint-disable no-restricted-syntax -- stripping a trailing line:column position from a file path string, not parsing source code */
  return sourcePath.replace(/:\d+:\d+$/, "");
  /* eslint-enable no-restricted-syntax */
}

/**
 * Derive a component name from its file path, or `null` when none can be
 * determined. Operates on a runtime file-path string, not source code.
 *
 * @example
 * inferNameFromFile("src/widgets/Item.vue") // "Item"
 * inferNameFromFile("src/widgets/Item.vue:4:2") // "Item"
 * inferNameFromFile("") // null
 */
function inferNameFromFile(filePath: string): string | null {
  /* eslint-disable no-restricted-syntax -- deriving a component name from a file path string, not parsing source code */
  const fileName = stripSourcePosition(filePath).split("/").pop();
  /* eslint-enable no-restricted-syntax */
  if (!fileName) {
    return null;
  }
  /* eslint-disable no-restricted-syntax -- stripping a .vue extension from a file name string, not parsing source code */
  return fileName.replace(/\.vue$/, "");
  /* eslint-enable no-restricted-syntax */
}

function isMeaningfulComponentName(name: string | null | undefined): name is string {
  return !!name && !ignoredComponentNamePattern.test(name.trim());
}

/**
 * Whether a runtime component tag looks like a real Vue component — PascalCase
 * or kebab-case — rather than a plain HTML element. Operates on a runtime tag
 * string, not source code.
 *
 * @example
 * isComponentLikeSourceTag("UserCard") // true
 * isComponentLikeSourceTag("my-button") // true
 * isComponentLikeSourceTag("div") // false
 */
function isComponentLikeSourceTag(tag: string | null | undefined): tag is string {
  /* eslint-disable no-restricted-syntax -- checking whether a runtime component tag looks like a Vue component (PascalCase or kebab), not parsing source code */
  return !!tag && (/[A-Z]/.test(tag.trim()) || tag.includes("-"));
  /* eslint-enable no-restricted-syntax */
}

/**
 * Format a component source path for display, optionally keeping its
 * `:line:column` position and trimming it to the `frontend/src/...` portion
 * when present. Operates on a runtime file-path string for display, not source
 * code.
 *
 * @example
 * formatSourceLabel("/x/frontend/src/Foo.vue:4:2") // "src/Foo.vue:4:2"
 * formatSourceLabel("/x/frontend/src/Foo.vue:4:2", false) // "src/Foo.vue"
 * formatSourceLabel("src/Foo.vue") // "src/Foo.vue"
 */
export function formatSourceLabel(sourcePath: string, includePosition = true): string {
  /* eslint-disable no-restricted-syntax -- parsing a file-path-with-optional-position string for display, not parsing source code */
  const match = sourcePath.match(/^(.*?)(?::(\d+):(\d+))?$/);
  /* eslint-enable no-restricted-syntax */
  if (!match) {
    return sourcePath;
  }

  const [, rawPath, line, column] = match;
  /* eslint-disable no-restricted-syntax -- extracting the frontend/src portion of a file path for display, not parsing source code */
  const frontendPathMatch = rawPath.match(/(?:^|\/)frontend\/(src\/.*)$/);
  /* eslint-enable no-restricted-syntax */
  const normalizedPath = frontendPathMatch?.[1] ?? rawPath;

  if (includePosition && line && column) {
    return `${normalizedPath}:${line}:${column}`;
  }

  return normalizedPath;
}

function getStringPropValue(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getDisplayComponentName(componentName: string | null | undefined, sourcePath?: string, sourceTag?: string | null): string | undefined {
  if (isComponentLikeSourceTag(sourceTag)) {
    return sourceTag.trim();
  }

  const inferredName = sourcePath ? inferNameFromFile(sourcePath) : null;
  if (isMeaningfulComponentName(inferredName)) {
    return inferredName;
  }

  if (isMeaningfulComponentName(componentName)) {
    return componentName.trim();
  }

  return undefined;
}

function resolveAnnotatedInfo(
  componentName: string | null | undefined,
  sourcePath: string | undefined,
  sourceTag: string | null | undefined,
): ResolvedVueComponentInfo | undefined {
  const component = getDisplayComponentName(componentName, sourcePath, sourceTag);
  const source = sourcePath ? formatSourceLabel(sourcePath, true) : undefined;

  if (!component && !source) {
    return undefined;
  }

  return {
    component,
    source,
    formatted: component
      ? source ? `${component} (${source})` : component
      : source,
  };
}

function getAnnotatedInfoFromElement(element: Element, options: VueDetectorOptions): ResolvedVueComponentInfo | undefined {
  const pomComponentAttribute = `${options.metadataAttributePrefix}-component`;
  const pomTagAttribute = `${options.metadataAttributePrefix}-tag`;
  const annotatedElement = element.closest<HTMLElement>(`[${pomComponentAttribute}], [${options.sourceAttribute}]`);
  if (!annotatedElement) {
    return undefined;
  }

  return resolveAnnotatedInfo(
    annotatedElement.getAttribute(pomComponentAttribute),
    annotatedElement.getAttribute(options.sourceAttribute) ?? undefined,
    annotatedElement.getAttribute(pomTagAttribute),
  );
}

function getAnnotatedInfoFromInstance(instance: VueInstance, options: VueDetectorOptions): ResolvedVueComponentInfo | undefined {
  const pomComponentAttribute = `${options.metadataAttributePrefix}-component`;
  const pomTagAttribute = `${options.metadataAttributePrefix}-tag`;
  return resolveAnnotatedInfo(
    getStringPropValue(instance.vnode?.props, pomComponentAttribute),
    getStringPropValue(instance.vnode?.props, options.sourceAttribute),
    getStringPropValue(instance.vnode?.props, pomTagAttribute),
  );
}

function getInstanceName(instance: VueInstance): ResolvedVueComponentInfo | undefined {
  if (instance.$options) {
    const name = instance.$options.name
      ?? instance.$options._componentTag
      ?? inferNameFromFile(instance.$options.__file ?? "");

    if (isMeaningfulComponentName(name)) {
      return {
        component: name,
        source: instance.$options.__file ? formatSourceLabel(instance.$options.__file, true) : undefined,
        formatted: instance.$options.__file ? `${name} (${formatSourceLabel(instance.$options.__file, true)})` : name,
      };
    }
  }

  if (instance.type) {
    const name = instance.type.name
      ?? instance.type.__name
      ?? inferNameFromFile(instance.type.__file ?? "");

    if (isMeaningfulComponentName(name)) {
      return {
        component: name,
        source: instance.type.__file ? formatSourceLabel(instance.type.__file, true) : undefined,
        formatted: instance.type.__file ? `${name} (${formatSourceLabel(instance.type.__file, true)})` : name,
      };
    }
  }

  return undefined;
}

function scoreInfo(info: ResolvedVueComponentInfo | undefined): number {
  if (!info) {
    return -1;
  }

  return (info.component ? 10 : 0) + (info.source ? 100 : 0);
}

export function resolveVueComponentInfo(element: Element, options: VueDetectorOptions): ResolvedVueComponentInfo | undefined {
  const annotatedElementInfo = getAnnotatedInfoFromElement(element, options);
  if (annotatedElementInfo) {
    return annotatedElementInfo;
  }

  const seenInstances = new Set<VueInstance>();
  let bestInfo: ResolvedVueComponentInfo | undefined;
  let bestScore = -1;
  let current: Element | null = element;
  let depth = 0;

  while (current && current !== document.body && depth < 50) {
    for (const instance of getDirectVueInstances(current)) {
      if (seenInstances.has(instance)) {
        continue;
      }

      seenInstances.add(instance);
      const annotatedInstanceInfo = getAnnotatedInfoFromInstance(instance, options);
      const candidate = annotatedInstanceInfo ?? getInstanceName(instance);
      const score = scoreInfo(candidate);
      if (score > bestScore) {
        bestInfo = candidate;
        bestScore = score;
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  return bestInfo;
}

// Exposed for unit tests. These are pure string helpers (no DOM access).
export const __internal = {
  ignoredComponentNamePattern,
  stripSourcePosition,
  inferNameFromFile,
  isComponentLikeSourceTag,
};
