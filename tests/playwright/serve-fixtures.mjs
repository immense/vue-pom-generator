import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = 4173;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultPath = "/tests/playwright/fixtures/pointer-callout/index.html";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
]);

function resolveRequestPath(urlPath) {
  const requestedPath = decodeURIComponent(urlPath === "/" ? defaultPath : urlPath);
  const resolvedPath = path.resolve(repoRoot, `.${requestedPath}`);
  if (!resolvedPath.startsWith(repoRoot)) {
    throw new Error(`Refusing to serve path outside repo root: ${requestedPath}`);
  }

  return resolvedPath;
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    let filePath = resolveRequestPath(requestUrl.pathname);
    const fileStats = await stat(filePath);
    if (fileStats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const fileContents = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypes.get(path.extname(filePath)) ?? "application/octet-stream");
    response.end(fileContents);
  }
  catch (error) {
    response.statusCode = (error && typeof error === "object" && "code" in error && error.code === "ENOENT") ? 404 : 500;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`Fixture server listening at http://${host}:${port}`);
});
