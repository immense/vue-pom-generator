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

const ignoredComponentNamePattern = /^(?:items\[\d+\]\.template|template|anonymous|slot|transition|transition-group)$/i;

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

function stripSourcePosition(sourcePath: string): string {
  return sourcePath.replace(/:\d+:\d+$/, "");
}

function inferNameFromFile(filePath: string): string | null {
  const fileName = stripSourcePosition(filePath).split("/").pop();
  if (!fileName) {
    return null;
  }
  return fileName.replace(/\.vue$/, "");
}

function isMeaningfulComponentName(name: string | null | undefined): name is string {
  return !!name && !ignoredComponentNamePattern.test(name.trim());
}

function isComponentLikeSourceTag(tag: string | null | undefined): tag is string {
  return !!tag && (/[A-Z]/.test(tag.trim()) || tag.includes("-"));
}

export function formatSourceLabel(sourcePath: string, includePosition = true): string {
  const match = sourcePath.match(/^(.*?)(?::(\d+):(\d+))?$/);
  if (!match) {
    return sourcePath;
  }

  const [, rawPath, line, column] = match;
  const frontendPathMatch = rawPath.match(/(?:^|\/)frontend\/(src\/.*)$/);
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
