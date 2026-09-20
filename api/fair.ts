// GET /api/fair[?symbol=SPYx|?mint=] -> the published FairPrice snapshot row(s) joined with the live devnet state
// and the lender-oracle comparison rows (web/data/lenders.json) when that snapshot exists.
// ponytail: no recomputation here; fairPrice() takes ~18s of upstream calls, the snapshot job owns that.
import { cache, clusterTime, CORS, fetchStates, json, readData, withVerdict } from "./_rambu.ts";

const rowsOf = (d: any, key = "rows"): any[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);
const matches = (r: any, x: any) => r.mint === x.mint || [x.symbol, x.underlying].includes(r.ticker);

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const q = new URL(req.url).searchParams;
    const fair = readData("fair.json"), lenders = readData("lenders.json");
    if (!fair) return json({ error: "fair.json snapshot missing from the deployment" }, 500);
    const want = q.get("symbol")?.toLowerCase(), wantMint = q.get("mint");
    const rows = rowsOf(fair).filter((r) => (!want || r.symbol.toLowerCase() === want) && (!wantMint || r.mint === wantMint));
    if ((want || wantMint) && !rows.length) return json({ error: `no FairPrice row for ${want ?? wantMint}`, symbols: rowsOf(fair).map((r) => r.symbol) }, 404, cache(30));

    // onchain is best-effort: the snapshot is still worth serving when devnet RPC is down
    let states: any[] = [], now = 0, onchainError: string | undefined;
    try { [states, now] = await Promise.all([fetchStates(), clusterTime()]); } catch (e: any) { onchainError = e.message; }
    const out = rows.map((r) => {
      const s = states.find((x) => x.mint === r.mint);
      // lenders.json (keeper/board.ts): per-market oracle readings by xStock mint, issuer wrappers by underlying ticker
      const l = rowsOf(lenders, "lenders").filter((x) => matches(x, r)), w = rowsOf(lenders, "wrappers").filter((x) => matches(x, r));
      return {
        symbol: r.symbol, mint: r.mint,
        snapshot: { at: fair.at, ...r },
        onchain: s ? { clusterTime: now, ...withVerdict(s, now) } : null,
        ...(lenders ? { lenders: { at: lenders.at ?? null, bandBp: lenders.bandBp ?? null, markets: l, wrappers: w } } : {}),
      };
    });
    return json({ snapshotAt: fair.at, refresh: fair.refresh ?? null, lendersAt: lenders?.at ?? null, curators: lenders?.curators ?? null, onchainError, rows: out }, 200, cache(30));
  },
};
