import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    stdio: "inherit",
    ...options,
  });
}

function runCapture(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    ...options,
  });
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");

const peerVite = "7.3.1";
const peerVue = "3.5.22";
const peerPluginVue = "6.0.1";

function lastNonEmptyLine(value) {
  // Avoid regex and split/replace/match-style parsing (repo lint rule).
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") {
      end -= 1;
      continue;
    }
    break;
  }

  let start = end;
  while (start > 0) {
    const ch = value[start - 1];
    if (ch === "\n" || ch === "\r") {
      break;
    }
    start -= 1;
  }

  return value.slice(start, end);
}

let tempRoot = "";

try {
  // Ensure dist is current.
  run("yarn", ["build"], { cwd: packageDir });

  // Create a packed tarball.
  const packOutRaw = runCapture("npm", ["pack", "--silent"], { cwd: packageDir });
  if (!packOutRaw) {
    throw new Error("npm pack produced no output");
  }

  const tarballName = lastNonEmptyLine(packOutRaw);
  if (!tarballName) {
    throw new Error(`Unable to parse npm pack output: ${packOutRaw}`);
  }
  const tarballPath = path.resolve(packageDir, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Packed tarball not found: ${tarballPath}`);
  }

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vue-pom-generator-pack-"));
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "vue-pom-generator-packed-smoke", private: true, type: "module" }, null, 2),
    "utf8",
  );

  // Install peers + the packed tarball as a consumer would.
  run(
    "npm",
    [
      "install",
      "--silent",
      "--no-audit",
      "--no-fund",
      `${tarballPath}`,
      `vite@${peerVite}`,
      `vue@${peerVue}`,
      `@vitejs/plugin-vue@${peerPluginVue}`,
    ],
    { cwd: tempRoot },
  );

  // Verify we can import and create plugins.
  run(
    "node",
    [
      "-e",
      [
        "(async () => {",
        "  const m = await import('@immense/vue-pom-generator');",
        "  if (typeof m.createVuePomGeneratorPlugins !== 'function') {",
        "    throw new Error('Expected createVuePomGeneratorPlugins export');",
        "  }",
        "  const plugins = m.createVuePomGeneratorPlugins({ generation: false });",
        "  if (!Array.isArray(plugins)) {",
        "    throw new Error('Expected createVuePomGeneratorPlugins to return an array');",
        "  }",
        "  console.log('[packed-smoke] ok: plugins=', plugins.length);",
        "})();",
      ].join("\n"),
    ],
    { cwd: tempRoot },
  );

  // Cleanup tarball + temp workspace.
  fs.rmSync(tarballPath, { force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = "";
}
catch (err) {
  if (tempRoot) {
    // Keep the temp folder for inspection.
    console.error(`[packed-smoke] failed; temp dir preserved at: ${tempRoot}`);
  }
  throw err;
}
