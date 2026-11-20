// @vitest-environment node
import { describe, expect, it } from "vitest";

import { __internal } from "../plugin/runtime/annotator/plugin";

const { addComponentSourcePath } = __internal;

describe("annotator source paths in builds", () => {
  it("sets __file on the component a compiled SFC exports through _export_sfc", () => {
    const compiled = [
      "const _sfc_main = { name: \"Card\" };",
      "function _sfc_render() {}",
      "export default /*#__PURE__*/_export_sfc(_sfc_main, [[\"render\", _sfc_render]]);",
    ].join("\n");

    const updated = addComponentSourcePath(compiled, "src/components/Card.vue");

    // Appended, so the compiled code and its source map are unchanged above it.
    expect(updated?.startsWith(compiled)).toBe(true);
    expect(updated).toContain("_sfc_main.__file = \"src/components/Card.vue\";");
  });

  it("sets __file on a component exported directly, and leaves a module without a component alone", () => {
    expect(addComponentSourcePath("const _sfc_main = {};\nexport default _sfc_main;", "../shared/ui/src/Card.vue"))
      .toContain("_sfc_main.__file = \"../shared/ui/src/Card.vue\";");
    expect(addComponentSourcePath("export const value = 1;", "src/Plain.vue")).toBeUndefined();
    expect(addComponentSourcePath("export default { name: \"Inline\" };", "src/Inline.vue")).toBeUndefined();
  });
});
