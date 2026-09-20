// QA dev server: serves web/ with the real vercel.json headers (so CSP is under test) and routes /api/* to the
// actual handlers in api/. Stands in for `vercel dev`, which needs a linked project.
// ponytail: rewrites/redirects are read from vercel.json too, so the Blink paths behave as deployed.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = join(root, "web");
const vercel = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".svg": "image/svg+xml", ".css": "text/css", ".ico": "image/x-icon" };

const HANDLERS: Record<string, string> = {
  "/api/state": "../api/state.ts",
  "/api/fair": "../api/fair.ts",
  "/api/history": "../api/history.ts",
  "/api/actions/tradable": "../api/actions/tradable.ts",
  "/api/actions/lp": "../api/actions/lp.ts",
};

// vercel.json "headers" entries whose source regex matches the path
// ponytail: keys lowercased so a handler's own header replaces the config one instead of being sent twice.
// Vercel does not document which side wins; on the deployed site check `curl -sI` for a doubled
// "access-control-allow-origin: *, *", which browsers reject.
const headersFor = (path: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const h of vercel.headers ?? []) {
    if (!new RegExp(`^${h.source}$`).test(path)) continue;
    for (const { key, value } of h.headers) out[key.toLowerCase()] = value;
  }
  return out;
};

// vercel.json rewrites: /api/actions/tradable/:ticker -> /api/actions/tradable?ticker=:ticker
function rewrite(u: URL): URL {
  for (const r of vercel.rewrites ?? []) {
    const names: string[] = [];
    const re = new RegExp(`^${r.source.replace(/:(\w+)/g, (_: string, n: string) => { names.push(n); return "([^/]+)"; })}$`);
    const m = re.exec(u.pathname);
    if (!m) continue;
    let dest = r.destination;
    names.forEach((n, i) => (dest = dest.replaceAll(`:${n}`, m[i + 1])));
    const next = new URL(dest, u.origin);
    for (const [k, v] of u.searchParams) if (!next.searchParams.has(k)) next.searchParams.set(k, v);
    return next;
  }
  return u;
}

const port = Number(process.env.PORT ?? 8799);

createServer(async (req, res) => {
  let u: URL;
  try { u = rewrite(new URL(req.url ?? "/", `http://localhost:${port}`)); } catch { return res.writeHead(400).end(); }

  const mod = HANDLERS[u.pathname.replace(/\/$/, "")];
  if (u.pathname.startsWith("/api/")) {
    if (!mod) return res.writeHead(404, headersFor(u.pathname)).end("not found");
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Promise<string>((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s)); });
      const h = (await import(mod)).default;
      const r: Response = await h.fetch(new Request(u.toString(), { method: req.method, headers: req.headers as any, body }));
      const out: Record<string, string> = { ...headersFor(u.pathname) };
      r.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
    } catch (e: any) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: `qa server: ${e.message}` }));
    }
    return;
  }

  let path: string;
  try { path = normalize(decodeURIComponent(u.pathname)).replace(/^[/\\]+/, ""); } catch { return res.writeHead(400).end(); }
  if (path.startsWith("..")) return res.writeHead(403).end();
  const file = path || "index.html";
  try {
    const body = await readFile(join(web, file));
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", ...headersFor(u.pathname) }).end(body);
  } catch {
    try { res.writeHead(404, { "content-type": "text/html; charset=utf-8", ...headersFor(u.pathname) }).end(await readFile(join(web, "404.html"))); }
    catch { res.writeHead(404).end("not found"); }
  }
}).listen(port, () => console.log(`qa server http://localhost:${port}`));
