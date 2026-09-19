// Run SEWA-Replay on the SPYx/USDC Raydium CLMM pools and write web/data/sewa.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { feedOf } from "./pyth.ts";
import { candles, readPool, readPositions, referencePath, replay } from "./sewa.ts";

const POOLS = (process.env.POOLS ?? "4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw,6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE").split(",");
const DAYS = Number(process.env.DAYS ?? 30);
const TICKER = "SPY", XSYM = "SPYx", MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const dir = new URL("../web/data/", import.meta.url);
mkdirSync(dir, { recursive: true });

const schedule = (await feedOf(TICKER)).schedule; // Pyth's session calendar for the underlying
const ref = await referencePath(TICKER, XSYM, MINT);
const $ = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const out = [];
for (const id of POOLS) {
  const pool = await readPool(id);
  const positions = await readPositions(id);
  // sanity: today's positions in range at the current tick must add up to the pool's active liquidity
  const L = positions.filter((p) => p.lower <= pool.tick && pool.tick < p.upper).reduce((a, p) => a + p.liquidity, 0);
  const cacheFile = fileURLToPath(new URL(`ohlcv-${id}.json`, dir));
  const cs = await candles(id, DAYS, cacheFile);
  writeFileSync(cacheFile, JSON.stringify(cs));
  const a = replay(pool, positions, cs, schedule, ref);
  console.log(`\n${id.slice(0, 6)} fee ${pool.feeRate * 1e4}bp, cut ${pool.protocolCut * 100}%, ${positions.length} positions (sum L in range / pool L = ${(L / pool.liquidity).toFixed(4)}), ${((a.to - a.from) / 864e5).toFixed(1)} days`);
  let tf = 0, tl = 0;
  for (const s of Object.keys(a.bySession) as (keyof typeof a.bySession)[]) {
    const b = a.bySession[s], g = a.gate[s];
    tf += b.feesUsd; tl += b.lvrUsd;
    console.log(`  ${s.padEnd(9)} vol ${$(b.volUsd).padStart(12)}  fees ${$(b.feesUsd).padStart(8)}  LVR ${$(b.lvrUsd).padStart(8)}  net/day ${$(g.meanDaily).padStart(7)} [95% ${$(g.lo)}, ${$(g.hi)}]`);
  }
  console.log(`  TOTAL fees ${$(tf)}  LVR ${$(tl)}  net ${$(tf - tl)}`);
  out.push({ pool, from: a.from, to: a.to, positions: positions.length, bySession: a.bySession, gate: a.gate, days: a.days,
    pos: a.top.map((p) => [p.nft, p.lower, p.upper, +p.inRangePct.toFixed(1), +p.feesUsd.toFixed(2), +p.lvrUsd.toFixed(2)]) });
}
writeFileSync(new URL("sewa.json", dir), JSON.stringify({ at: Date.now(), days: DAYS, ticker: TICKER, xsymbol: XSYM, pools: out }));
