// Tiny static server for web/ (fetching data/*.json needs http, not file://).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../web/", import.meta.url));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".svg": "image/svg+xml", ".css": "text/css" };
const port = Number(process.env.PORT ?? 8080);
createServer(async (req, res) => {
  let path: string;
  try { path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^[/\\]+/, ""); } catch { return res.writeHead(400).end(); }
  if (path.startsWith("..")) return res.writeHead(403).end();
  const file = path || "index.html";
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end("not found"); }
}).listen(port, () => console.log(`http://localhost:${port}`));
