import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT || 4173);
const root = new URL(".", import.meta.url).pathname;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer(async (request, response) => {
  try {
    const rawPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const safePath = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, "");
    let path = join(root, safePath === "/" ? "index.html" : safePath);
    if (!(await stat(path)).isFile()) path = join(root, "index.html");
    response.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    });
    response.end(await readFile(path));
  } catch (error) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Not found\n${error.message}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MoeMotion is running at http://127.0.0.1:${port}`);
});
