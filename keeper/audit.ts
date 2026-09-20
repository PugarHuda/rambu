// Run SEWA-Replay on the xStock Raydium-CLMM-layout pools and write web/data/sewa.json (+ positions-<pool>.json caches).
//
// sewa.json contract (web + docs read it):
// { at, days, ticker: "SPY", xsymbol: "SPYx" (legacy single-asset fields = the first target), tickers: string[], dropped: [{ id, reason }], pools: [{
//     id (= pool.id), pool: { id, program, mint0, mint1, dec0, dec1, tickSpacing, liquidity, tick, feeRate, protocolCut },
//     ticker, xsym, refSource: "pyth-pro" | "yahoo+es+hl", refFill (Hyperliquid perp filling weekend/holiday holes),
//     refVsPoolBp (median |fair - pool candle| in bp),
//     from, to (ms), positions,
//     bySession: { regular|pre|post|overnight|closed|reopen: { minutes, volUsd, feesUsd, lvrUsd (todayL), lvrGated,
//                  sigma (annualized), pTrade, arb, arbFees, noiseFees } },   // "reopen" = first step after a >60 min gap
//     gate: { <session>: { meanDaily, lo, hi, days, loExBest, robust } },     // net/day, week-block bootstrap 95% CI
//     days: { "YYYY-MM-DD" (New York trading date): { <session>: net } },     // only sessions active that day
//     bounds: { lvrTodayL, lvrOpenGated },
//     calib: { n, owedUsd, replayUsd, ratio },  // onchain uncollected fees vs replay, positions opened in window, never decreased
//     history: { ok, broken },
//     pos: [[nft, lower, upper, inRangePct, feesUsd, lvrUsd, owner, openedAt (ISO string), owedUsd, replayFeesLifetime], ...] }] }
// openedAt is a string on purpose: readers that take "the first number after index 5" as owedUsd (api/actions/lp.ts) stay right.
// Headline per pool: net = sum(feesUsd) - sum(lvrUsd). pos fees/LVR use each position's L_p(t) (open-gated).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { feedOf } from "./pyth.ts";
import {
  candles, crossPath, feesOwed, KEYS, NotEntitled, owners, positionHistory, pythPath, readPool, readPositions, referencePath, replay,
  type Ref, type Target,
} from "./sewa.ts";

const SOL = "So11111111111111111111111111111111111111112";
const TARGETS: (Target & { pools: string[] })[] = [
  // 27x6aS is Byreal (REALQ…), a Raydium CLMM fork: same PoolState / PersonalPositionState sizes, program read from the owner.
  { ticker: "SPY", xsym: "SPYx", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", proxy: "ES=F", perp: "xyz:SP500", pools: ["4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw", "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE", "27x6aSxcAm6SoazoxmmTtFg6fWMQuNmdKJmHagq1DUZy"] },
  { ticker: "QQQ", xsym: "QQQx", mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", proxy: "NQ=F", perp: "xyz:XYZ100", pools: ["GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG", "B6FEtQdwsq8Wuw4G52pW9WEWEA7ALGfyUgXDRKigDSHH"] },
  { ticker: "TSLA", xsym: "TSLAx", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", perp: "xyz:TSLA", pools: ["8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF"] },
];
const ONLY = process.env.POOLS?.split(",");
const DAYS = Number(process.env.DAYS ?? 30);
const dir = new URL("../web/data/", import.meta.url);
mkdirSync(dir, { recursive: true });
const now = Date.now();
const $ = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const out: any[] = [], dropped: { id: string; reason: string }[] = [];
let solRef: Ref[] | undefined;

for (const tg of TARGETS) {
  const ids = tg.pools.filter((id) => !ONLY || ONLY.some((o) => id.startsWith(o)));
  if (!ids.length) continue;
  const schedule = (await feedOf(tg.ticker)).schedule; // Pyth's session calendar for the underlying
  const { ref: xRef, source, fill, mDrift } = await referencePath(tg, DAYS, now);
  console.log(`\n${tg.ticker}: reference ${source} (holes filled from ${fill ?? "nothing"}), ${xRef.length} points; issuer multiplier history vs mint today ${(mDrift * 1e4).toFixed(3)}bp`);
  for (const id of ids) {
    const pool = await readPool(id);
    let ref = xRef;
    if (pool.mint0 === SOL && pool.mint1 === tg.mint) {
      try { solRef ??= await pythPath("Crypto.SOL/USD", now / 1000 - (DAYS + 3) * 86400, now / 1000); }
      catch (e) { if (e instanceof NotEntitled) { dropped.push({ id, reason: `SOL reference: ${e.message}` }); continue; } throw e; }
      ref = crossPath(xRef, solRef);
    } else if (pool.mint0 !== tg.mint) { dropped.push({ id, reason: `token0 ${pool.mint0} is not ${tg.xsym}` }); continue; }

    const cacheFile = fileURLToPath(new URL(`ohlcv-${id}.json`, dir));
    const cs = await candles(id, DAYS, cacheFile, now);
    writeFileSync(cacheFile, JSON.stringify(cs));
    // Scaling sanity: Gecko prices the xStock leg in USD; compare with the fair path (px for xStock/USDC, q for xStock/SOL).
    const devs: number[] = [];
    for (let i = 0, k = -1; i < cs.length; i++) {
      const t = cs[i][0] * 1000;
      while (k + 1 < ref.length && ref[k + 1][0] <= t) k++;
      if (k >= 0 && t - ref[k][0] < 600e3) devs.push(Math.abs(Math.log(cs[i][4] / (ref === xRef ? ref[k][1] : ref[k][2]!))) * 1e4);
    }
    const refVsPoolBp = +median(devs).toFixed(1);
    if (ref !== xRef && !(refVsPoolBp < 50)) { dropped.push({ id, reason: `xStock/SOL scaling check failed: median ${refVsPoolBp}bp vs pool` }); continue; }

    const positions = await readPositions(pool);
    const L = positions.filter((p) => p.lower <= pool.tick && pool.tick < p.upper).reduce((a, p) => a + p.liquidity, 0);
    const posFile = new URL(`positions-${id}.json`, dir);
    const cache = existsSync(posFile) ? JSON.parse(readFileSync(posFile, "utf8")) : {};
    const hist = await positionHistory(pool, positions, cache, cs[0][0] * 1000, (m) => console.log(m));
    // ponytail: owners are re-read only for entries rebuilt this run (a liquidity event) or never resolved; an NFT moved
    // without touching the position keeps its old owner here until then. The web lookup scans the wallet live anyway.
    const need = positions.filter((p) => !hist[p.pda!].owner);
    const own = await owners(need.map((p) => p.nft));
    for (const p of need) hist[p.pda!] = { ...hist[p.pda!], owner: own.get(p.nft) ?? null };
    writeFileSync(posFile, JSON.stringify(hist));
    let ok = 0;
    for (const p of positions) { const h = hist[p.pda!]; if (h.ok) ok++; p.steps = h.ok ? h.steps : [[h.openedAt, p.liquidity]]; }

    const a = replay(pool, positions, cs, schedule, ref);
    const owed = await feesOwed(pool, positions);
    const last = ref.at(-1)!, q = last[2] ?? 1, usd0 = last[1] * q; // USD per raw token0 / token1 at the latest fair price
    const byPda = new Map(positions.map((p) => [p.pda!, p]));
    let cn = 0, co = 0, cr = 0;
    const pos = a.top.map((r) => {
      const h = hist[r.pda!], o = owed.get(r.pda!), p = byPda.get(r.pda!)!;
      const owedUsd = o ? (Number(o[0]) / 10 ** pool.dec0) * usd0 + (Number(o[1]) / 10 ** pool.dec1) * q : null;
      // replay saw its whole life, nothing collected yet; only reported next to a known owedUsd (it exists for that
      // comparison, and it keeps "the first number after the owner" unambiguous for api/actions/lp.ts)
      const lifetime = owedUsd != null && h.ok && h.openedAt >= a.from && h.decreases === 0 ? r.feesUsd : null;
      if (lifetime != null && owedUsd != null && p) { cn++; co += owedUsd; cr += lifetime; }
      return [r.nft, r.lower, r.upper, +r.inRangePct.toFixed(1), +r.feesUsd.toFixed(2), +r.lvrUsd.toFixed(2), h.owner ?? null, h.openedAt ? new Date(h.openedAt).toISOString() : null, owedUsd == null ? null : +owedUsd.toFixed(2), lifetime == null ? null : +lifetime.toFixed(2)];
    });
    const calib = { n: cn, owedUsd: +co.toFixed(2), replayUsd: +cr.toFixed(2), ratio: cr ? +(co / cr).toFixed(3) : null };

    let tf = 0, tl = 0;
    console.log(`\n${id.slice(0, 6)} ${tg.xsym}/${pool.mint0 === SOL ? "SOL" : "USDC"} ${pool.program!.slice(0, 5)} fee ${+(pool.feeRate * 1e4).toFixed(2)}bp, cut ${+(pool.protocolCut * 100).toFixed(1)}%, ${positions.length} positions (sum L in range / pool L = ${(L / pool.liquidity).toFixed(4)}), ${((a.to - a.from) / 864e5).toFixed(1)} days`);
    console.log(`  ref ${source}, fair vs pool candles median ${refVsPoolBp}bp; history ok ${ok}/${positions.length}; owners ${positions.filter((p) => hist[p.pda!].owner).length}/${positions.length} (${need.length} looked up); owed read ${owed.size}/${positions.length}`);
    for (const s of KEYS) {
      const b = a.bySession[s], g = a.gate[s];
      if (!b.minutes && !b.lvrUsd) continue;
      tf += b.feesUsd; tl += b.lvrUsd;
      console.log(`  ${s.padEnd(9)} vol ${$(b.volUsd).padStart(12)} fees ${$(b.feesUsd).padStart(7)} LVR ${$(b.lvrUsd).padStart(7)} (gated ${$(b.lvrGated)}) σ ${(b.sigma * 100).toFixed(0)}% P ${b.pTrade.toFixed(2)} arbFees ${$(b.arbFees)} noise ${$(b.noiseFees)}  net/day ${$(g.meanDaily)} [${$(g.lo)}, ${$(g.hi)}] exBest ${$(g.loExBest)} ${g.robust ? "PASS" : "-"}`);
    }
    console.log(`  TOTAL fees ${$(tf)}  LVR [todayL ${$(a.bounds.lvrTodayL)}, openGated ${$(a.bounds.lvrOpenGated)}]  net ${$(tf - tl)}  owed/replay ${calib.ratio ?? "n/a"} (${cn} positions, owed ${$(co)} vs replay ${$(cr)})`);
    out.push({
      id, pool: a.pool, ticker: tg.ticker, xsym: tg.xsym, refSource: source, refFill: fill, refVsPoolBp, from: a.from, to: a.to, positions: positions.length,
      bySession: a.bySession, gate: a.gate, days: a.days, bounds: a.bounds, calib, history: { ok, broken: positions.length - ok }, pos,
    });
  }
}
for (const d of dropped) console.log(`dropped ${d.id}: ${d.reason}`);
// POOLS=<prefix> re-audits some pools: the others (and their dropped notes) are carried over from the last snapshot
const sewaFile = new URL("sewa.json", dir);
if (ONLY && existsSync(sewaFile)) {
  const prev = JSON.parse(readFileSync(sewaFile, "utf8")), mine = (id: string) => ONLY.some((o) => id.startsWith(o));
  out.push(...(prev.pools ?? []).filter((p: any) => !mine(p.pool.id)));
  dropped.push(...(prev.dropped ?? []).filter((d: any) => !mine(d.id)));
  const order = TARGETS.flatMap((t) => t.pools);
  out.sort((a, b) => order.indexOf(a.pool.id) - order.indexOf(b.pool.id));
}
writeFileSync(sewaFile, JSON.stringify({ at: now, days: DAYS, ticker: TARGETS[0].ticker, xsymbol: TARGETS[0].xsym, tickers: TARGETS.map((t) => t.ticker), dropped, pools: out }));
