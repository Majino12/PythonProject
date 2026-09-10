import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 4173);
const root = fileURLToPath(new URL(".", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function generateAvatar(request, response) {
  try {
    const { apiKey, description, style = "anime" } = await readJson(request);
    if (typeof apiKey !== "string" || !apiKey.startsWith("sk-") || apiKey.length < 20) {
      return sendJson(response, 400, { error: "请输入有效的 OpenAI API Key" });
    }
    if (typeof description !== "string" || description.trim().length < 3 || description.length > 800) {
      return sendJson(response, 400, { error: "角色描述需要 3–800 个字符" });
    }
    const styleGuide = {
      anime: "polished modern anime illustration, clean cel shading, expressive design",
      soft: "soft Japanese illustration, gentle pastel colors, delicate clean line art",
      game: "premium game character concept art, crisp shapes, vivid but balanced colors",
    }[style] || "polished modern anime illustration";
    const prompt = [
      "Create a production-ready VTuber character image optimized for automatic 2D motion tracking and procedural 3D avatar creation.",
      styleGuide + ".",
      `Character request: ${description.trim()}`,
      "Show one single character from head to mid-thigh, facing directly forward in a neutral symmetrical pose.",
      "Keep both eyes fully open, mouth gently closed, face unobstructed, shoulders level, and both arms slightly separated from the torso with hands visible.",
      "Centered composition, transparent background, even soft lighting, clean silhouette, no text, no logo, no border, no props covering the face or body.",
    ].join(" ");
    const upstream = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt,
        size: "1024x1536",
        quality: "medium",
        background: "transparent",
        output_format: "png",
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const upstreamMessage = result?.error?.message || `OpenAI API 请求失败（${upstream.status}）`;
      return sendJson(response, upstream.status, { error: upstreamMessage });
    }
    const image = result?.data?.[0]?.b64_json;
    if (!image) return sendJson(response, 502, { error: "API 没有返回图片，请稍后重试" });
    return sendJson(response, 200, { image, format: "png", model: "gpt-image-2" });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    const invalidJson = error instanceof SyntaxError;
    const status = timedOut ? 504 : invalidJson ? 400 : 500;
    const message = timedOut ? "生成超时，请稍后重试" : invalidJson ? "请求格式不正确" : error.message || "生成失败";
    return sendJson(response, status, { error: message });
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/generate-avatar") {
      await generateAvatar(request, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
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
