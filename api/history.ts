// GET /api/history[?ticker=SPYx][&limit=300][&format=atom] -> keeper push history from devnet transactions.
// Decodes every rambu `upsert` ix (the keeper's full payload) plus the StateChanged event it emitted, then
// compresses runs of unchanged status into one entry per ticker. Atom: one entry per status change.
import { b58, b64, cache, CORS, DEVNET, disc, eventDisc, explorer, EVENT, HALT, json, PROGRAM, rpc, SESSION, unb58 } from "./_rambu.ts";

export type Push = {
  sig: string; slot: number; t: number; mint: string; ticker: string; session: string; halt: string; haltCode: string;
  haltedAt: number; resumeAt: number; event: string; eventRef: string; refPrice: number; bandBps: number; maxAgeS: number;
  emitted?: Record<string, unknown>;
};
export type Run = Omit<Push, "refPrice"> & { until: number; pushes: number; refFirst: number; refLast: number };

const txt = (b: Uint8Array) => new TextDecoder().decode(b).replace(/[\0 ]+$/, "");

// UpsertArgs after the 8-byte discriminator (lib.rs order): ticker[12] session halt code[4] haltedAt resumeAt event ref[20] price band maxAge
export function decodeUpsert(d: Uint8Array) {
  if (d.length < 77) return undefined;
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  return {
    ticker: txt(d.subarray(8, 20)), session: SESSION[d[20]] ?? String(d[20]), halt: HALT[d[21]] ?? String(d[21]),
    haltCode: txt(d.subarray(22, 26)), haltedAt: Number(v.getBigInt64(26, true)), resumeAt: Number(v.getBigInt64(34, true)),
    event: EVENT[d[42]] ?? String(d[42]), eventRef: txt(d.subarray(43, 63)),
    refPrice: Number(v.getBigUint64(63, true)) / 1e6, bandBps: v.getUint16(71, true), maxAgeS: v.getUint32(73, true),
  };
}

// StateChanged v1 { mint, halt, event, session } (43 bytes) or v2 (97 bytes, + ref, prev ref, band, max age,
// halt code, event ref, updated_at). Heartbeat { mint, updated_at } is what v2 emits for an unchanged refresh.
export function decodeEvent(d: Uint8Array, kind: "StateChanged" | "Heartbeat" = "StateChanged") {
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  if (kind === "Heartbeat") return d.length >= 48 ? { kind, mint: b58(d.subarray(8, 40)), updatedAt: Number(v.getBigInt64(40, true)) } : undefined;
  if (d.length < 43) return undefined;
  const e: Record<string, unknown> = { kind, mint: b58(d.subarray(8, 40)), halt: d[40], event: d[41], session: d[42] };
  if (d.length >= 97) Object.assign(e, {
    refPrice: Number(v.getBigUint64(43, true)) / 1e6, prevRefPrice: Number(v.getBigUint64(51, true)) / 1e6,
    bandBps: v.getUint16(59, true), maxAgeS: v.getUint32(61, true), haltCode: txt(d.subarray(65, 69)),
    eventRef: txt(d.subarray(69, 89)), updatedAt: Number(v.getBigInt64(89, true)),
  });
  return e;
}

const KEY = (p: Push) => [p.session, p.halt, p.haltCode, p.event, p.eventRef, p.bandBps, p.maxAgeS].join("|");
export function compress(pushes: Push[]): Record<string, Run[]> {
  const out: Record<string, Run[]> = {};
  for (const p of [...pushes].sort((a, b) => a.slot - b.slot)) {
    const runs = (out[p.ticker] ??= []), last = runs.at(-1);
    if (last && KEY(last as any) === KEY(p)) { last.until = p.t; last.pushes++; last.refLast = p.refPrice; continue; }
    const { refPrice, ...rest } = p;
    runs.push({ ...rest, until: p.t, pushes: 1, refFirst: refPrice, refLast: refPrice });
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

const TX = new Map<string, any>();
async function pushes(limit: number): Promise<{ out: Push[]; scanned: number; missing: number; throttled: boolean }> {
  const sigs: any[] = await rpc(DEVNET, "getSignaturesForAddress", [PROGRAM, { limit, commitment: "confirmed" }]);
  const [UPSERT, CHANGED, BEAT] = await Promise.all([disc("upsert"), eventDisc("StateChanged"), eventDisc("Heartbeat")]);
  const same = (a: Uint8Array, b: Uint8Array) => a.length >= 8 && b.every((x, i) => a[i] === x);
  // ponytail: public devnet allows 40 calls / 10 s per method per IP, and a burst past it gets the IP 429'd for
  // minutes. So pace starts to one per 300 ms unless DEVNET_RPC names a keyed endpoint, and stop reading at the
  // first call that stays 429 after rpc()'s backoff. Confirmed txs never change, so warm instances keep them;
  // a 45 s budget keeps the function under maxDuration. The CDN (s-maxage + swr) absorbs page loads.
  const gap = process.env.DEVNET_RPC ? 0 : 300, deadline = Date.now() + 45_000;
  let next = 0, throttled = false;
  const txs = await pool(sigs.filter((s) => !s.err), 4, async (s) => {
    if (TX.has(s.signature)) return TX.get(s.signature);
    const at = Math.max(Date.now(), next);
    next = at + gap;
    if (throttled || at > deadline) return null;
    if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
    const tx = await rpc(DEVNET, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }])
      .catch((e) => { if (/too many|429/i.test(e.message)) throttled = true; return null; });
    if (tx) TX.set(s.signature, tx);
    return tx;
  });
  const out: Push[] = [];
  for (const tx of txs) {
    if (!tx) continue;
    const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const events = (tx.meta.logMessages ?? []).filter((l: string) => l.startsWith("Program data: "))
      .map((l: string) => b64(l.slice(14)))
      .map((d: Uint8Array) => (same(d, CHANGED) ? decodeEvent(d) : same(d, BEAT) ? decodeEvent(d, "Heartbeat") : undefined)).filter(Boolean);
    let n = 0;
    for (const ix of tx.transaction.message.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM) continue;
      const d = unb58(ix.data);
      if (!same(d, UPSERT)) continue;
      const u = decodeUpsert(d);
      if (!u) continue;
      out.push({ sig: tx.transaction.signatures[0], slot: tx.slot, t: tx.blockTime, mint: keys[ix.accounts[2]], ...u, ...(events[n] ? { emitted: events[n] } : {}) });
      n++;
    }
  }
  return { out, scanned: sigs.length, missing: txs.filter((t) => !t).length, throttled };
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
const iso = (t: number) => new Date(t * 1000).toISOString();
export function atom(series: Record<string, Run[]>, self: string): string {
  const entries = Object.values(series).flat().sort((a, b) => b.t - a.t);
  const status = (r: Run) => (r.halt !== "none" ? `${r.halt}${r.haltCode ? ` (${r.haltCode})` : ""}` : r.event !== "none" ? `event: ${r.event}` : r.haltCode === "DIV" ? "dividend pending (DIV)" : "tradable");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Rambu keeper: xStock status changes (devnet)</title>
<id>urn:rambu:devnet:${PROGRAM}</id>
<link rel="self" href="${esc(self)}"/>
<link href="${explorer("address", PROGRAM)}"/>
<updated>${iso(entries[0]?.until ?? 0)}</updated>
<author><name>Rambu keeper</name></author>
${entries.map((r) => `<entry>
<title>${esc(`${r.ticker}: ${status(r)}, ${r.session}, ref $${r.refFirst.toFixed(2)}`)}</title>
<id>urn:solana:devnet:tx:${r.sig}</id>
<link href="${explorer("tx", r.sig)}"/>
<updated>${iso(r.t)}</updated>
<summary>${esc(`${r.ticker} (mint ${r.mint}) status ${status(r)} in session ${r.session}${r.eventRef ? `, SEC accession ${r.eventRef}` : ""}. Held for ${r.pushes} keeper push(es) until ${iso(r.until)}; ref $${r.refFirst.toFixed(2)} -> $${r.refLast.toFixed(2)}, band ±${r.bandBps / 100}%, max age ${r.maxAgeS}s.`)}</summary>
</entry>`).join("\n")}
</feed>
`;
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const u = new URL(req.url), q = u.searchParams;
    const limit = Math.min(1000, Math.max(1, Number(q.get("limit")) || 300));
    const ticker = q.get("ticker")?.toLowerCase();
    try {
      const { out, scanned, missing, throttled } = await pushes(limit);
      const ttl = cache(missing ? 15 : 60); // partial read: let the next request fill the gap sooner
      const all = out.filter((p) => !ticker || p.ticker.toLowerCase() === ticker);
      const series = compress(all);
      if (q.get("format") === "atom")
        return new Response(atom(series, u.toString()), { headers: { "content-type": "application/atom+xml; charset=utf-8", ...CORS, ...ttl } });
      const prices: Record<string, [number, number][]> = {};
      for (const p of [...all].sort((a, b) => a.slot - b.slot)) (prices[p.ticker] ??= []).push([p.t, p.refPrice]);
      return json({ cluster: "devnet", program: PROGRAM, scanned, unreadable: missing, throttled, pushes: all.length, from: Math.min(...all.map((p) => p.t)) || null, to: Math.max(...all.map((p) => p.t)) || null, series, prices }, 200, ttl);
    } catch (e: any) {
      return json({ error: e.message }, 502);
    }
  },
};
