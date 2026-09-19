// SEWA-Replay: replay a Raydium CLMM xStock pool minute by minute and attribute LP fees vs LVR
// to every live position, split by Pyth's own market-session calendar.
import { existsSync, readFileSync } from "node:fs";
import { address, getAddressDecoder } from "@solana/kit";
import { mainnet, sessionAt, type Schedule, type Sess } from "./pyth.ts";

const CLMM = address("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const addr = (b: Buffer, o: number) => getAddressDecoder().decode(b.subarray(o, o + 32));

export type Pool = { id: string; mint0: string; mint1: string; dec0: number; dec1: number; tickSpacing: number; liquidity: number; tick: number; feeRate: number; protocolCut: number };
export type Position = { nft: string; lower: number; upper: number; liquidity: number };
export type Candle = [t: number, o: number, h: number, l: number, c: number, volUsd: number];

// Offsets checked against mainnet PoolState / AmmConfig / PersonalPositionState (19 Sep 2026).
export async function readPool(id: string): Promise<Pool> {
  const b = Buffer.from((await mainnet.getAccountInfo(address(id), { encoding: "base64" }).send()).value!.data[0], "base64");
  const c = Buffer.from((await mainnet.getAccountInfo(addr(b, 9), { encoding: "base64" }).send()).value!.data[0], "base64");
  return {
    id, mint0: addr(b, 73), mint1: addr(b, 105), dec0: b[233], dec1: b[234], tickSpacing: b.readUInt16LE(235),
    liquidity: Number(u128(b, 237)), tick: b.readInt32LE(269),
    feeRate: c.readUInt32LE(47) / 1e6, protocolCut: (c.readUInt32LE(43) + c.readUInt32LE(53)) / 1e6, // protocol + fund share of the trade fee
  };
}

export async function readPositions(pool: string): Promise<Position[]> {
  const r: any[] = await mainnet.getProgramAccounts(CLMM, { encoding: "base64", filters: [{ dataSize: 281n }, { memcmp: { offset: 41n, bytes: pool as any, encoding: "base58" } }] }).send();
  return r.map((x) => {
    const b = Buffer.from(x.account.data[0], "base64");
    return { nft: addr(b, 9), lower: b.readInt32LE(73), upper: b.readInt32LE(77), liquidity: Number(u128(b, 81)) };
  }).filter((p) => p.liquidity > 0);
}

// GeckoTerminal minute candles, prices in USD per raw token (same basis as the pool). 30 req/min public limit.
export async function candles(pool: string, days: number, cacheFile?: string): Promise<Candle[]> {
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  const out = new Map<number, Candle>();
  const stop = Date.now() / 1000 - days * 86400;
  let before = Math.floor(Date.now() / 1000);
  while (before > stop) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&before_timestamp=${before}`);
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 15000)); continue; }
    const list: Candle[] = (await r.json()).data?.attributes?.ohlcv_list ?? [];
    if (!list.length) break;
    for (const c of list) if (c[0] >= stop) out.set(c[0], c);
    before = Math.min(...list.map((c) => c[0]));
    await new Promise((s) => setTimeout(s, 2100));
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

export const tickOf = (rawPrice: number) => Math.floor(Math.log(rawPrice) / Math.log(1.0001));

export type Bucket = { minutes: number; volUsd: number; feesUsd: number; lvrUsd: number };
export type PosAudit = { nft: string; lower: number; upper: number; inRangePct: number; feesUsd: number; lvrUsd: number; netUsd: number; bySession: Record<Sess, Bucket> };
export type Audit = {
  pool: Pool; from: number; to: number; positions: number; bySession: Record<Sess, Bucket>; days: Record<string, Record<Sess, number>>;
  gate: Record<Sess, { meanDaily: number; lo: number; hi: number; days: number }>; top: PosAudit[];
};

const SESS: Sess[] = ["regular", "pre", "post", "overnight", "closed"];
const empty = (): Record<Sess, Bucket> => Object.fromEntries(SESS.map((s) => [s, { minutes: 0, volUsd: 0, feesUsd: 0, lvrUsd: 0 }])) as any;

/** Reference path point: [epoch ms, fair USD price per raw token]. */
export type Ref = [t: number, px: number];

/**
 * Fees: every pool minute, vol * feeRate * (1 - protocolCut), split pro-rata over positions in range.
 * LVR: every reference step, r^2 * L * sqrt(P) / 4 (Milionis et al., CLMM in-range form; P, L raw units),
 * r = log return of the EXTERNAL fair price. The pool's own candles are too noisy to use (GeckoTerminal minute
 * closes cluster at ±25/±50bp jumps). Range membership also follows the fair price, forward-filled.
 * ponytail: position set is today's snapshot (no open/close history); swap-level indexing lifts that.
 */
export function replay(pool: Pool, positions: Position[], cs: Candle[], schedule: Schedule, ref: Ref[]): Audit {
  const scale = 10 ** (pool.dec1 - pool.dec0); // USD per raw token -> raw1 per raw0
  const pos = positions.map((p) => ({ ...p, fees: 0, lvr: 0, inRange: 0, by: empty() }));
  const by = empty();
  const days: Record<string, Record<Sess, number>> = {};
  const inRangeAt = (usd: number) => {
    const tick = tickOf(usd * scale);
    const r = pos.filter((p) => p.lower <= tick && tick < p.upper);
    return { r, L: r.reduce((a, p) => a + p.liquidity, 0) };
  };
  const book = (t: number, s: Sess, fee: number, lvr: number, vol: number, minute: boolean) => {
    const b = by[s];
    if (minute) b.minutes++;
    b.volUsd += vol; b.feesUsd += fee; b.lvrUsd += lvr;
    const day = new Date(t).toISOString().slice(0, 10);
    (days[day] ??= Object.fromEntries(SESS.map((x) => [x, 0])) as any)[s] += fee - lvr;
  };
  const from = cs[0]?.[0] * 1000;
  const refs = ref.filter((r) => r[0] >= from);
  let fair = ref.filter((r) => r[0] < from).at(-1)?.[1] ?? cs[0]?.[4]; // last fair price before the window
  let j = 0;
  for (const c of cs) {
    const t = c[0] * 1000;
    // LVR for every fair-price step up to this minute
    for (; j < refs.length && refs[j][0] <= t; j++) {
      const [rt, px] = refs[j];
      if (fair) {
        const { r, L } = inRangeAt(px);
        const lvr = (Math.log(px / fair) ** 2 * L * Math.sqrt(px * scale)) / 4 / 10 ** pool.dec1;
        const s = sessionAt(schedule, rt);
        book(rt, s, 0, lvr, 0, false);
        for (const p of r) { const w = (p.liquidity / L) * lvr; p.lvr += w; p.by[s].lvrUsd += w; }
      }
      fair = px;
    }
    const s = sessionAt(schedule, t);
    const { r, L } = inRangeAt(fair ?? c[4]);
    const fee = L ? c[5] * pool.feeRate * (1 - pool.protocolCut) : 0;
    book(t, s, fee, 0, c[5], true);
    for (const p of r) {
      const w = p.liquidity / L;
      p.fees += fee * w; p.inRange++;
      const pb = p.by[s]; pb.minutes++; pb.volUsd += c[5] * w; pb.feesUsd += fee * w;
    }
  }
  const gate = Object.fromEntries(SESS.map((s) => [s, bootstrap(Object.values(days).map((d) => d[s]))])) as Audit["gate"];
  const top = pos
    .map((p) => ({ nft: p.nft, lower: p.lower, upper: p.upper, inRangePct: (100 * p.inRange) / Math.max(1, cs.length), feesUsd: p.fees, lvrUsd: p.lvr, netUsd: p.fees - p.lvr, bySession: p.by }))
    .sort((a, b) => b.feesUsd + b.lvrUsd - (a.feesUsd + a.lvrUsd));
  return { pool, from: cs[0]?.[0] * 1000, to: cs.at(-1)?.[0]! * 1000, positions: positions.length, bySession: by, days, gate, top };
}

async function yahoo5m(sym: string): Promise<Ref[]> {
  const j: any = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=60d&interval=5m&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0" } })).json();
  const r = j.chart.result[0], close: (number | null)[] = r.indicators.quote[0].close;
  return r.timestamp.map((ts: number, i: number) => [ts * 1000, close[i]]).filter((x: any) => x[1] != null);
}

// Drop isolated bad prints: a jump > minBp that the very next print undoes (Yahoo after-hours has these,
// e.g. SPY 17 Sep 16:15 ET -110bp then +107bp). Real moves don't revert within one bar.
export function despike(xs: Ref[], minBp = 25, revert = 0.7): Ref[] {
  return xs.filter((x, i) => {
    const a = xs[i - 1], b = xs[i + 1];
    if (!a || !b) return true;
    const r1 = Math.log(x[1] / a[1]) * 1e4, r2 = Math.log(b[1] / x[1]) * 1e4;
    return !(Math.abs(r1) > minBp && Math.sign(r1) !== Math.sign(r2) && Math.abs(r2) >= revert * Math.abs(r1));
  });
}

/**
 * Fill gaps in the stock's own prints (overnight, weekend) with a 24h proxy's returns chained onto the last print.
 * When the stock prints again the path snaps back to it; that snap is the real overnight basis error, kept in.
 */
export function splice(stock: Ref[], proxy: Ref[], maxGap = 10 * 60e3): Ref[] {
  const out: Ref[] = [];
  let k = 0;
  for (let i = 0; i < stock.length; i++) {
    out.push(stock[i]);
    const next = stock[i + 1];
    if (!next || next[0] - stock[i][0] <= maxGap) continue;
    while (k < proxy.length && proxy[k][0] <= stock[i][0]) k++;
    const base = proxy[k - 1];
    if (!base) continue;
    for (; k < proxy.length && proxy[k][0] < next[0]; k++) out.push([proxy[k][0], (stock[i][1] * proxy[k][1]) / base[1]]);
  }
  return out;
}

/**
 * Fair USD price per raw token over time: underlying 5-minute prints (regular + pre/post), overnight gaps filled
 * with S&P futures, × multiplier(t), plus any dividend already ex but not yet stepped into the multiplier
 * (otherwise the ex-date drop looks like a crash).
 * ponytail: Yahoo 5m is unofficial; Pyth Pro history replaces it once a key is set.
 * multiplierAt only knows the mint's last step, fine for windows after that step.
 */
export async function referencePath(ticker: string, xsymbol: string, mintAddr: string, proxy = "ES=F", now = Date.now()): Promise<Ref[]> {
  const { readMint, dividends, corporateActions, pendingDividend, whtOf, multiplierAt } = await import("./fairprice.ts");
  const [mint, divs, cas, stock, fut] = await Promise.all([readMint(mintAddr), dividends(ticker), corporateActions(), yahoo5m(ticker), yahoo5m(proxy)]);
  const mine = cas.filter((c) => c.symbol === xsymbol);
  const pend = pendingDividend(divs, mine, now);
  const net = pend ? pend.amount * (1 - whtOf(mine)) : 0;
  const adj = despike(stock).map(([t, px]) => [t, px + (pend && t >= pend.exDate ? net : 0)] as Ref);
  return splice(adj, fut).map(([t, px]) => [t, px * multiplierAt(mint, t)]);
}

// Mean daily net with a 95% bootstrap CI (deterministic LCG so reruns match).
export function bootstrap(xs: number[], n = 2000) {
  if (!xs.length) return { meanDaily: 0, lo: 0, hi: 0, days: 0 };
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const means = Array.from({ length: n }, () => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)]; return s / xs.length; }).sort((a, b) => a - b);
  return { meanDaily: xs.reduce((a, b) => a + b, 0) / xs.length, lo: means[Math.floor(n * 0.025)], hi: means[Math.floor(n * 0.975)], days: xs.length };
}
