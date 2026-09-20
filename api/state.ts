// GET /api/state[?ticker=SPYx|?mint=<xStock mint>][&price=680] -> live devnet StockState(s) + check_with() verdict at
// cluster time (no price: judged at the onchain reference, the get_price rules). For a single state the program's own
// get_price is simulated too, so callers get the reference straight from the program's return data.
import { cache, clusterTime, CORS, decodePrice, DEVNET, explorer, fetchStates, getPriceIx, json, PROGRAM, simulate, withVerdict } from "./_rambu.ts";

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const q = new URL(req.url).searchParams;
    const ticker = q.get("ticker")?.toLowerCase(), mint = q.get("mint"), price = Number(q.get("price") ?? 0);
    if (!Number.isFinite(price) || price < 0) return json({ error: "price must be a non-negative number" }, 400);
    try {
      const [all, now] = await Promise.all([fetchStates(), clusterTime()]);
      const states: any[] = all
        .filter((s) => (!ticker || s.ticker.toLowerCase() === ticker) && (!mint || s.mint === mint))
        .map((s) => ({ ...withVerdict(s, now, Math.round(price * 1e6)), explorer: explorer("address", s.key) }));
      if ((ticker || mint) && !states.length) return json({ error: `no Rambu state for ${ticker ?? mint}`, tickers: all.map((s) => s.ticker) }, 404, cache(30));
      if (states.length === 1) {
        const s = states[0];
        const sim = await simulate(await getPriceIx(s.mint), [{ pubkey: s.key, signer: false, writable: false }]);
        s.getPrice = { verdict: sim.verdict, ...(sim.returnData ? decodePrice(sim.returnData) : {}), unitsConsumed: sim.unitsConsumed };
      }
      return json({ cluster: "devnet", rpc: DEVNET, program: PROGRAM, clusterTime: now, priceChecked: price || null, states }, 200, cache(30));
    } catch (e: any) {
      return json({ error: e.message }, 502);
    }
  },
};
