// SEWA-Replay: replay a Raydium-CLMM-layout xStock pool minute by minute and attribute LP fees vs LVR to every
// live position, split by Pyth's own market-session calendar, then check the replay against onchain fee growth.
import { existsSync, readFileSync } from "node:fs";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { MAINNET, sessionAt, type Schedule, type Sess } from "./pyth.ts";

const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const addr = (b: Buffer, o: number) => getAddressDecoder().decode(b.subarray(o, o + 32));
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

// Raw JSON-RPC with backoff. The public endpoint throttles hard (getTransaction ~1-2/s), so every
// heavy call goes through here. Set MAINNET_RPC to a keyed endpoint to go faster.
const PUBLIC = MAINNET.includes("api.mainnet-beta.solana.com");
const PACE: Record<string, number> = PUBLIC ? { getTransaction: 1500, getSignaturesForAddress: 150, getProgramAccounts: 150 } : {}; // ms between calls, measured
const nextAt: Record<string, number> = {};
export async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0, wait = 1000; ; i++, wait = Math.min(wait * 2, 20000)) {
    if (PACE[method]) {
      const now = Date.now(), at = Math.max(now, nextAt[method] ?? 0);
      nextAt[method] = at + PACE[method];
      if (at > now) await sleep(at - now);
    }
    const r = await fetch(MAINNET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch(() => null);
    if (!r || r.status === 429 || r.status >= 500) {
      if (i >= 12) throw new Error(`rpc ${method} ${r?.status ?? "network"}`);
      await sleep(Math.max(wait, Number(r?.headers.get("retry-after") ?? 0) * 1000));
      continue;
    }
    const j: any = await r.json();
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result;
  }
}

export async function mapLimit<T, R>(xs: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (k < xs.length) { const i = k++; out[i] = await f(xs[i], i); } }));
  return out;
}

export type Pool = { id: string; program?: string; mint0: string; mint1: string; dec0: number; dec1: number; tickSpacing: number; liquidity: number; tick: number; feeRate: number; protocolCut: number };
export type Position = {
  nft: string; lower: number; upper: number; liquidity: number;
  pda?: string; steps?: [t: number, L: number][]; // L_p(t) from the position's own tx history; absent = today's L all window
  raw?: { liq: bigint; fg0: bigint; fg1: bigint; owed0: bigint; owed1: bigint };
};
export type Candle = [t: number, o: number, h: number, l: number, c: number, volUsd: number];

const POOL_SIZE = 1544, POSITION_SIZE = 281; // Raydium CLMM PoolState / PersonalPositionState; Byreal (REALQ…) is a fork with the same layout

// Offsets checked against mainnet PoolState / AmmConfig / PersonalPositionState (19 Sep 2026). The program id is the
// pool account's owner, so any fork with the identical layout works; anything else is refused by the size check.
export async function readPool(id: string): Promise<Pool> {
  const a: any = await rpc("getAccountInfo", [id, { encoding: "base64" }]);
  const b = Buffer.from(a.value.data[0], "base64");
  if (b.length !== POOL_SIZE) throw new Error(`${id}: ${b.length} bytes, not a Raydium CLMM PoolState`);
  const c = Buffer.from((await rpc<any>("getAccountInfo", [addr(b, 9), { encoding: "base64" }])).value.data[0], "base64");
  // Byreal's PoolState (onchain IDL) has trade_fee_rate u32@393 overriding the config when non-zero (27x6aS: 80 = 0.8bp,
  // not the config's 20bp; confirmed by its fee_growth vs swap counters), and decay/dynamic fee flags in u8@1096 (bit0, bit4).
  // On Raydium both are padding = 0.
  if (b[1096] & 0b10001) throw new Error(`${id}: Byreal decay/dynamic fee enabled, flat-fee replay would be wrong`);
  return {
    id, program: a.value.owner, mint0: addr(b, 73), mint1: addr(b, 105), dec0: b[233], dec1: b[234], tickSpacing: b.readUInt16LE(235),
    liquidity: Number(u128(b, 237)), tick: b.readInt32LE(269),
    feeRate: (b.readUInt32LE(393) || c.readUInt32LE(47)) / 1e6, protocolCut: (c.readUInt32LE(43) + c.readUInt32LE(53)) / 1e6, // protocol + fund share of the trade fee
  };
}

export async function readPositions(pool: Pool): Promise<Position[]> {
  const r: any[] = await rpc("getProgramAccounts", [pool.program, { encoding: "base64", filters: [{ dataSize: POSITION_SIZE }, { memcmp: { offset: 41, bytes: pool.id } }] }]);
  return r.map((x) => {
    const b = Buffer.from(x.account.data[0], "base64");
    const liq = u128(b, 81);
    return {
      nft: addr(b, 9), pda: x.pubkey as string, lower: b.readInt32LE(73), upper: b.readInt32LE(77), liquidity: Number(liq),
      raw: { liq, fg0: u128(b, 97), fg1: u128(b, 113), owed0: b.readBigUInt64LE(129), owed1: b.readBigUInt64LE(137) },
    };
  }).filter((p) => p.liquidity > 0);
}

// GeckoTerminal minute candles, prices in USD per raw token of the Gecko base. 30 req/min public limit.
// Incremental: keep the cached minutes still inside the window, fetch only from now back to the newest cached one.
export async function candles(pool: string, days: number, cacheFile?: string, now = Date.now()): Promise<Candle[]> {
  const stop = now / 1000 - days * 86400;
  const cached: Candle[] = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : [];
  const out = new Map<number, Candle>(cached.filter((c) => c[0] >= stop).map((c) => [c[0], c]));
  const have = [...out.keys()].reduce((a, t) => Math.max(a, t), stop);
  let before = Math.floor(now / 1000), throttled = 0;
  while (before > have) {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&before_timestamp=${before}`);
    if (r.status === 429) {
      if (++throttled > 8) throw new Error("gecko 429");
      await sleep(15000);
      continue;
    }
    if (!r.ok) throw new Error(`gecko ${r.status}`);
    throttled = 0;
    const list: Candle[] = (await r.json()).data?.attributes?.ohlcv_list ?? [];
    if (!list.length) break;
    for (const c of list) if (c[0] >= stop) out.set(c[0], c); // the newest cached minute is refetched: it may have been partial
    before = Math.min(...list.map((c) => c[0]));
    await sleep(2100);
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

export const tickOf = (rawPrice: number) => Math.floor(Math.log(rawPrice) / Math.log(1.0001));

// Exact loss-versus-rebalancing of one CLMM position when the fair price jumps P0 -> P1 (raw token1 per raw token0):
// reserves held at P0 valued at P1, minus the reserves the pool leaves it with at P1. With c = sqrtP clamped to
// [sa, sb], x = L(1/c - 1/sb), y = L(c - sa), so loss = P1(x0 - x1) + (y0 - y1) = L(c1 - c0)(P1 - c0c1)/(c0c1).
// In range this is L(sqrtP1 - sqrtP0)^2/sqrtP0 ≈ r^2 L sqrtP / 4; both ends past the same edge give 0.
const lossSqrt = (L: number, sa: number, sb: number, s0: number, s1: number) => {
  const c0 = Math.min(Math.max(s0, sa), sb), c1 = Math.min(Math.max(s1, sa), sb);
  return c0 === c1 ? 0 : (L * (c1 - c0) * (s1 * s1 - c0 * c1)) / (c0 * c1);
};
export const stepLoss = (L: number, lower: number, upper: number, P0: number, P1: number) =>
  lossSqrt(L, 1.0001 ** (lower / 2), 1.0001 ** (upper / 2), Math.sqrt(P0), Math.sqrt(P1));

// Milionis-Moallemi-Roughgarden (2023), LVR with fees and discrete blocks: probability an arbitrageur trades in a
// block of dt seconds, sigma per sqrt(second), fee as a rate. P = 1 without a fee, falls as the fee rises.
export const pTrade = (sigma: number, fee: number, dt: number) => 1 / (1 + fee / (sigma * Math.sqrt(dt / 2)));
const SLOT_S = 0.4;

export type Key = Sess | "reopen"; // "reopen": the first reference step after a gap > 60 min (weekend, holiday, outage)
export const KEYS: Key[] = ["regular", "pre", "post", "overnight", "closed", "reopen"];
export type Bucket = {
  minutes: number; volUsd: number; feesUsd: number; lvrUsd: number; lvrGated: number;
  sigma: number; pTrade: number; arb: number; arbFees: number; noiseFees: number;
};
export type Gate = { meanDaily: number; lo: number; hi: number; days: number; loExBest: number; robust: boolean };
export type PosAudit = { nft: string; pda?: string; lower: number; upper: number; inRangePct: number; feesUsd: number; lvrUsd: number; lvrTodayL: number; netUsd: number };
export type Audit = {
  pool: Pool; from: number; to: number; positions: number; bySession: Record<Key, Bucket>; days: Record<string, Partial<Record<Key, number>>>;
  gate: Record<Key, Gate>; bounds: { lvrTodayL: number; lvrOpenGated: number }; top: PosAudit[];
};

const empty = (): Record<Key, Bucket> =>
  Object.fromEntries(KEYS.map((s) => [s, { minutes: 0, volUsd: 0, feesUsd: 0, lvrUsd: 0, lvrGated: 0, sigma: 0, pTrade: 1, arb: 0, arbFees: 0, noiseFees: 0 }])) as any;

// America/New_York trading date: the overnight session from 20:00 ET belongs to the next day.
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const dayCache = new Map<number, string>();
export const tradingDay = (t: number) => {
  const h = Math.floor(t / 3600e3);
  let d = dayCache.get(h);
  if (!d) dayCache.set(h, (d = NY.format(h * 3600e3 + 4 * 3600e3)));
  return d;
};

/**
 * Reference path point: [epoch ms, fair price of token0 in token1 raw units (pre-multiplier UI), USD per token1 unit].
 * The third element defaults to 1 (USDC quote); an xStock/SOL pool carries the xStock's USD price there.
 */
export type Ref = [t: number, px: number, q?: number];

/**
 * Fees: every pool minute, vol * feeRate * (1 - protocolCut), when any of today's positions is in range at the fair
 * price; a position's share is L_p(t) (from its tx history) over max(today's in-range L, live in-range L).
 * LVR: every reference step, exact per-position stepLoss on the fair price (the pool's own minute candles are too noisy:
 * GeckoTerminal closes cluster at ±25/±50bp jumps). Two bounds: todayL (today's positions, today's L, all window) is the
 * pool-level headline, the same assumption the pool-level fee total makes; openGated uses each position's L_p(t).
 * ponytail: positions closed before today are invisible to both; swap-level indexing lifts that.
 */
export function replay(pool: Pool, positions: Position[], cs: Candle[], schedule: Schedule, ref: Ref[]): Audit {
  const scale = 10 ** (pool.dec1 - pool.dec0), d1 = 10 ** pool.dec1; // price per raw token -> raw1 per raw0
  const pos = positions.map((p) => ({ p, sa: 1.0001 ** (p.lower / 2), sb: 1.0001 ** (p.upper / 2), k: -1, fees: 0, lvr: 0, lvrT: 0, inRange: 0 }));
  type X = (typeof pos)[number];
  const lg = (x: X, t: number) => { // L_p(t), steps walked forward once since t only increases
    const s = x.p.steps;
    if (!s) return x.p.liquidity;
    while (x.k + 1 < s.length && s[x.k + 1][0] <= t) x.k++;
    return x.k < 0 ? 0 : s[x.k][1];
  };
  const by = empty();
  const vs = Object.fromEntries(KEYS.map((k) => [k, { r2: 0, dt: 0 }])) as Record<Key, { r2: number; dt: number }>;
  const days: Audit["days"] = {};
  const book = (t: number, k: Key, net: number) => { const d = (days[tradingDay(t)] ??= {}); d[k] = (d[k] ?? 0) + net; };
  const from = cs[0]?.[0] * 1000;
  const refs = ref.filter((r) => r[0] >= from);
  let prev: Ref | undefined = ref.filter((r) => r[0] < from).at(-1); // last fair price before the window
  let j = 0;
  for (const c of cs) {
    const t = c[0] * 1000;
    for (; j < refs.length && refs[j][0] <= t; j++) {
      const r = refs[j];
      if (prev) {
        const gap = r[0] - prev[0];
        // bars are stamped at their close, so a step ending at t covers (prev, t]: its session is the one just before t
        // (the Friday 19:59 ET bar closes at 20:00 = "closed", but it moved during post-market)
        const k: Key = gap > 3600e3 ? "reopen" : sessionAt(schedule, r[0] - 1);
        const s0 = Math.sqrt(prev[1] * scale), s1 = Math.sqrt(r[1] * scale), usd = (r[2] ?? 1) / d1;
        let lt = 0, lgs = 0;
        for (const x of pos) {
          const a = lossSqrt(1, x.sa, x.sb, s0, s1) * usd;
          if (!a) continue;
          const vt = a * x.p.liquidity, vg = a * lg(x, r[0]);
          lt += vt; lgs += vg; x.lvrT += vt; x.lvr += vg;
        }
        by[k].lvrUsd += lt; by[k].lvrGated += lgs;
        book(r[0], k, -lt);
        if (gap <= 600e3 && k !== "reopen") { vs[k].r2 += Math.log(r[1] / prev[1]) ** 2; vs[k].dt += gap / 1000; }
      }
      prev = r;
    }
    if (!prev) continue; // no fair price yet
    const k = sessionAt(schedule, t), s = Math.sqrt(prev[1] * scale);
    let LT = 0, LG = 0;
    const inr: [X, number][] = [];
    for (const x of pos) if (x.sa <= s && s < x.sb) { LT += x.p.liquidity; const g = lg(x, t); if (g) { LG += g; inr.push([x, g]); } }
    const fee = LT ? c[5] * pool.feeRate * (1 - pool.protocolCut) : 0;
    const b = by[k];
    b.minutes++; b.volUsd += c[5]; b.feesUsd += fee;
    book(t, k, fee);
    // share = L_p(t) / in-range L; the denominator is at least today's in-range L (the pool-depth assumption the headline
    // makes), so positions closed since then are not silently handed to the survivors. calib in audit.ts checks this.
    for (const [x, g] of inr) { x.fees += (fee * g) / Math.max(LT, LG); x.inRange++; }
  }
  for (const k of KEYS) {
    const b = by[k], sig = vs[k].dt ? Math.sqrt(vs[k].r2 / vs[k].dt) : 0;
    b.sigma = sig * Math.sqrt(365 * 86400); // annualized, from reference steps <= 10 min apart
    b.pTrade = k === "reopen" || !sig ? 1 : pTrade(sig, pool.feeRate, SLOT_S); // ponytail: a reopen gap is one jump, far past any fee
    b.arb = b.lvrUsd * b.pTrade; b.arbFees = b.lvrUsd * (1 - b.pTrade); b.noiseFees = b.feesUsd - b.arbFees;
  }
  const gate = Object.fromEntries(KEYS.map((k) => [k, bootstrap(Object.entries(days).filter(([, d]) => d[k] !== undefined).map(([day, d]) => [day, d[k]!]))])) as Audit["gate"];
  const top = pos
    .map((x) => ({ nft: x.p.nft, pda: x.p.pda, lower: x.p.lower, upper: x.p.upper, inRangePct: (100 * x.inRange) / Math.max(1, cs.length), feesUsd: x.fees, lvrUsd: x.lvr, lvrTodayL: x.lvrT, netUsd: x.fees - x.lvr }))
    .sort((a, b) => b.feesUsd + b.lvrUsd - (a.feesUsd + a.lvrUsd));
  const sum = (f: (b: Bucket) => number) => KEYS.reduce((a, k) => a + f(by[k]), 0);
  return { pool, from, to: cs.at(-1)?.[0]! * 1000, positions: positions.length, bySession: by, days, gate, bounds: { lvrTodayL: sum((b) => b.lvrUsd), lvrOpenGated: sum((b) => b.lvrGated) }, top };
}

// ---- reference path ----

async function yahoo5m(sym: string): Promise<Ref[]> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=60d&interval=5m&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`yahoo ${sym} ${r.status}`);
  const x = (await r.json()).chart.result[0], close: (number | null)[] = x.indicators.quote[0].close;
  return x.timestamp.map((ts: number, i: number) => [(ts + 300) * 1000, close[i]]).filter((p: any) => p[1] != null); // stamped at bar close
}

// Pyth Pro minute bars (TradingView {s,t,o,h,l,c}) -> [bar close ms, close].
export const pythBars = (j: { t?: number[]; c?: number[] }): Ref[] => (j.t ?? []).map((t, i) => [(t + 60) * 1000, j.c![i]]);

export class NotEntitled extends Error {}
// Pyth Pro history, 1-minute bars, <=30-day requests. 403 (feed outside the token's grant) and a missing token throw
// NotEntitled so the caller can fall back; anything else is a real error.
export async function pythPath(symbol: string, fromS: number, toS: number): Promise<Ref[]> {
  const token = process.env.PYTH_PRO_TOKEN;
  if (!token) throw new NotEntitled("no PYTH_PRO_TOKEN");
  const out = new Map<number, number>();
  for (let a = Math.floor(fromS); a < toS; a += 30 * 86400) {
    const u = `https://pyth.dourolabs.app/v1/fixed_rate@1000ms/history?symbol=${encodeURIComponent(symbol)}&from=${a}&to=${Math.floor(Math.min(toS, a + 30 * 86400))}&resolution=1`; // integer seconds or 400
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 403) throw new NotEntitled(`pyth-pro 403 ${symbol}`);
    if (!r.ok) throw new Error(`pyth-pro ${r.status} ${symbol}: ${(await r.text()).slice(0, 200)}`);
    for (const [t, c] of pythBars(await r.json())) out.set(t, c);
  }
  return [...out].sort((a, b) => a[0] - b[0]);
}

// Hyperliquid candles, paged forward (<=5000 per call). The API keeps only the last 5000 bars per interval, so 5m reaches
// ~17 days back; older minutes come from 15m bars. HIP-3 "xyz:" perps trade through weekends and holidays.
export async function hl5m(coin: string, fromMs: number, toMs = Date.now()): Promise<Ref[]> {
  const get = async (interval: string, ms: number) => {
    const out: Ref[] = [];
    for (let start = fromMs; start < toMs; ) {
      const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: toMs } }) });
      if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
      const xs: any[] = await r.json();
      for (const x of xs) out.push([x.T + 1, Number(x.c)]);
      if (xs.length < 5000) break;
      start = xs.at(-1).t + ms;
    }
    return out;
  };
  const [m5, m15] = await Promise.all([get("5m", 300e3), get("15m", 900e3)]);
  const first = m5[0]?.[0] ?? Infinity;
  return [...m15.filter((x) => x[0] < first), ...m5];
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
 * Chains: splice(splice(stock, futures), perp) fills what the futures leave open (their weekend) from the perp.
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

// xStock/SOL pool: token0 SOL, token1 the xStock. Price = SOL USD / xStock USD per raw token, q = xStock USD.
// Joined on the SOL minutes with the xStock forward-filled (it is closed while SOL trades on weekends).
export function crossPath(x: Ref[], sol: Ref[]): Ref[] {
  const out: Ref[] = [];
  let k = -1;
  for (const [t, s] of sol) {
    while (k + 1 < x.length && x[k + 1][0] <= t) k++;
    if (k >= 0) out.push([t, s / x[k][1], x[k][1]]);
  }
  return out;
}

// ---- issuer multiplier history ----

type CANode = { eventId: string; version: number; xstockSymbol: string; caType: string; effectiveTimeUtc: string; multiplierOld: string; multiplierNew: string; netCashflowUsd: string | null; grossCashflowUsd: string | null; withholdingTaxRate: string | null };
let caHist: CANode[] | undefined;
export async function caHistory(): Promise<CANode[]> {
  if (caHist) return caHist;
  const all: CANode[] = [];
  for (let page = 1; page < 100; page++) {
    const r = await fetch(`https://api.xstocks.fi/api/v2/public/corporate-actions/history?page=${page}&pageSize=100`, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`xstocks corporate-actions ${r.status}`);
    const j: any = await r.json();
    all.push(...(j.nodes ?? []));
    if (!j.page?.hasNextPage) break;
  }
  return (caHist = all);
}

// Highest version per eventId, then the multiplier as a step function: [[0, first old], [effective, new], ...].
export function multiplierSteps(nodes: CANode[], symbol: string): Ref[] {
  const best = new Map<string, CANode>();
  for (const n of nodes) if (n.xstockSymbol === symbol && (best.get(n.eventId)?.version ?? -1) < n.version) best.set(n.eventId, n);
  const xs = [...best.values()].sort((a, b) => Date.parse(a.effectiveTimeUtc) - Date.parse(b.effectiveTimeUtc));
  return [[0, Number(xs[0]?.multiplierOld ?? 1)], ...xs.map((n) => [Date.parse(n.effectiveTimeUtc), Number(n.multiplierNew)] as Ref)];
}
export const multiplierPath = async (symbol: string) => multiplierSteps(await caHistory(), symbol);
export const stepAt = (steps: Ref[], t: number) => { let m = steps[0]?.[1] ?? 1; for (const s of steps) if (s[0] <= t) m = s[1]; return m; };

// Net dividend owed at t: ex-date passed and the issuer has not yet stepped the multiplier for it (no step within
// 2 days before the ex-date or after). Same rule as fairprice.pendingDividend, applied at every point in history.
export function dividendOwed(divs: { exDate: number; amount: number }[], steps: Ref[], wht: number, t: number) {
  let owed = 0;
  for (const d of divs) if (d.exDate <= t && !steps.some((s) => s[0] >= d.exDate - 2 * 864e5 && s[0] <= t)) owed += d.amount * (1 - wht);
  return owed;
}

export type Target = { ticker: string; xsym: string; mint: string; proxy?: string; perp?: string };
/**
 * Fair USD price per raw token over time: Pyth Pro 1-minute bars of the underlying when the token is entitled, else
 * Yahoo 5-minute prints (regular + pre/post) spliced with CME futures; either way the holes left (Pyth has no weekend or
 * holiday bars, CME has none on weekends) are filled from a Hyperliquid 24/7 HIP-3 perp, so the weekend move is measured
 * in "closed" instead of landing as one jump in "reopen" (closed LVR would otherwise be 0 by construction); plus any dividend
 * already ex but not yet in the multiplier (else the ex-date drop looks like a crash); times the issuer's multiplier path.
 */
export async function referencePath(tg: Target, days: number, now = Date.now()): Promise<{ ref: Ref[]; source: "pyth-pro" | "yahoo+es+hl"; fill: string | null; mDrift: number }> {
  const { readMint, dividends, whtOf } = await import("./fairprice.ts");
  const fromMs = now - (days + 3) * 864e5;
  const perp = tg.perp ? await hl5m(tg.perp, fromMs, now) : [];
  let raw: Ref[], source: "pyth-pro" | "yahoo+es+hl";
  try {
    raw = splice(await pythPath(`Equity.US.${tg.ticker}/USD`, fromMs / 1000, now / 1000), perp);
    source = "pyth-pro";
  } catch (e) {
    if (!(e instanceof NotEntitled)) throw e;
    const [stock, fut] = await Promise.all([yahoo5m(tg.ticker), tg.proxy ? yahoo5m(tg.proxy) : []]);
    raw = splice(splice(despike(stock), fut), perp);
    source = "yahoo+es+hl";
  }
  const [nodes, divs, mint] = await Promise.all([caHistory(), dividends(tg.ticker), readMint(tg.mint)]);
  const steps = multiplierSteps(nodes, tg.xsym);
  const wht = whtOf(nodes.filter((n) => n.xstockSymbol === tg.xsym).map((n) => ({ symbol: n.xstockSymbol, type: n.caType, effective: Date.parse(n.effectiveTimeUtc), gross: 0, net: null, wht: n.withholdingTaxRate == null ? null : Number(n.withholdingTaxRate) })));
  const ref = raw.map(([t, px]) => [t, (px + dividendOwed(divs, steps, wht, t)) * stepAt(steps, t)] as Ref);
  // issuer history vs the mint's own ScaledUiAmount multiplier right now; should be 0
  const mNow = now >= mint.effective ? mint.newMultiplier : mint.multiplier;
  return { ref, source, fill: tg.perp ?? null, mDrift: stepAt(steps, now) / mNow - 1 };
}

// ---- statistics ----

// Mean daily net with a 95% block-bootstrap CI: days resampled in whole ISO weeks (Mon-based), so a weekly rhythm or
// one lucky week can't pass as independent days. loExBest = the same lower bound with the best day removed; robust
// needs both > 0 over at least two weeks. Deterministic LCG so reruns match.
export function bootstrap(xs: [day: string, v: number][], n = 2000): Gate {
  const mean = xs.reduce((a, x) => a + x[1], 0) / Math.max(1, xs.length);
  const ci = (ys: [string, number][]) => {
    const weeks = new Map<string, number[]>();
    for (const [d, v] of ys) {
      const t = Date.parse(d + "T00:00:00Z"), dow = (new Date(t).getUTCDay() + 6) % 7;
      const w = new Date(t - dow * 864e5).toISOString().slice(0, 10);
      (weeks.get(w) ?? weeks.set(w, []).get(w)!).push(v);
    }
    const ws = [...weeks.values()];
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const means = Array.from({ length: n }, () => {
      let s = 0, c = 0;
      for (let i = 0; i < ws.length; i++) for (const v of ws[Math.floor(rnd() * ws.length)]) { s += v; c++; }
      return s / c;
    }).sort((a, b) => a - b);
    return { lo: means[Math.floor(n * 0.025)], hi: means[Math.floor(n * 0.975)], weeks: ws.length };
  };
  if (!xs.length) return { meanDaily: 0, lo: 0, hi: 0, days: 0, loExBest: 0, robust: false };
  const all = ci(xs);
  const best = xs.reduce((b, x, i) => (x[1] > xs[b][1] ? i : b), 0);
  const ex = xs.length > 1 ? ci(xs.filter((_, i) => i !== best)).lo : -Infinity;
  return { meanDaily: mean, lo: all.lo, hi: all.hi, days: xs.length, loExBest: ex, robust: all.lo > 0 && ex > 0 && all.weeks >= 2 };
}

// ---- onchain truth: position history, owners, fees owed ----

// fp: the position account's L + fee_growth_inside_last + fees_owed when last built. Increase/Decrease (incl. a 0-L harvest)
// always rewrite fee_growth_inside_last, so an unchanged fp means no liquidity event since: no RPC at all for it.
// owner: NFT holder, filled by audit.ts when the entry is (re)built or missing.
export type Hist = { lastSig: string; openedAt: number; steps: [number, number][]; decreases: number; ok: boolean; fp?: string; owner?: string | null };
export const fpOf = (p: Position) => (p.raw ? `${p.raw.liq}:${p.raw.fg0}:${p.raw.fg1}:${p.raw.owed0}:${p.raw.owed1}` : undefined);
const DISC = { create: "641e57f9c4df9ace", increase: "314f69d420221e54", decrease: "3ade563a44325538" }; // sha256("event:<Name>")[0..8]

// Anchor events of one tx for one position -> liquidity delta. CreatePersonalPositionEvent carries no NFT mint, so it
// is matched on pool + ticks: pool@8, tick_lower@104, tick_upper@108, liquidity u128@112. Increase/Decrease: mint@8, L@40.
export function positionEvents(logs: string[], pool: string, p: { nft: string; lower: number; upper: number }) {
  const poolB = Buffer.from(getAddressEncoder().encode(address(pool))), nftB = Buffer.from(getAddressEncoder().encode(address(p.nft)));
  let create: bigint | undefined, delta = 0n, decreases = 0;
  for (const l of logs) {
    if (!l.startsWith("Program data: ")) continue;
    const d = Buffer.from(l.slice(14), "base64"), disc = d.subarray(0, 8).toString("hex");
    if (disc === DISC.create && d.length >= 128 && d.subarray(8, 40).equals(poolB) && d.readInt32LE(104) === p.lower && d.readInt32LE(108) === p.upper) create = u128(d, 112);
    else if ((disc === DISC.increase || disc === DISC.decrease) && d.length >= 56 && d.subarray(8, 40).equals(nftB)) {
      if (disc === DISC.increase) delta += u128(d, 40);
      else { delta -= u128(d, 40); decreases++; } // Raydium collects fees through DecreaseLiquidity (0 L = harvest)
    }
  }
  return { create, delta, decreases, truncated: logs.some((l) => l === "Log truncated") };
}

/**
 * L_p(t) per position from its own signatures. Only the window matters: L before it is L today minus the deltas decoded
 * inside it (or 0 before a Create inside it), so a position with no tx in the window, or whose only one is its open,
 * needs no getTransaction at all. Cached per pda with the newest signature seen; later runs decode only newer ones.
 * ok = false when a log was truncated / a tx pruned, or a Create-anchored replay misses today's L: caller uses constant L.
 */
export async function positionHistory(pool: Pool, ps: Position[], cache: Record<string, Hist>, fromMs: number, log = (_: string) => {}): Promise<Record<string, Hist>> {
  const out: Record<string, Hist> = {};
  let done = 0, txs = 0;
  await mapLimit(ps, 4, async (p) => {
    const fp = fpOf(p);
    if (fp && cache[p.pda!]?.fp === fp) return void (out[p.pda!] = cache[p.pda!]); // untouched since the last run (broken or not)
    const old = cache[p.pda!]?.ok ? cache[p.pda!] : undefined; // a broken entry is rebuilt from scratch
    const sigs: any[] = [];
    for (let before: string | undefined; ; ) {
      const page: any[] = await rpc("getSignaturesForAddress", [p.pda, { limit: 1000, ...(old ? { until: old.lastSig } : {}), ...(before ? { before } : {}) }]);
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1).signature;
    }
    if (!sigs.length && old) return void (out[p.pda!] = { ...old, fp });
    const good = sigs.filter((s) => !s.err).reverse(); // oldest first
    const openedAt = old?.openedAt ?? (good[0]?.blockTime ?? 0) * 1000;
    const todo = old ? good : good.filter((s) => s.blockTime * 1000 >= fromMs && !(s === good[0] && good.length === 1));
    const evs: { t: number; create?: bigint; delta: bigint }[] = [];
    let broken = false, decreases = old?.decreases ?? 0;
    for (const s of todo) {
      const tx: any = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 1, encoding: "json", commitment: "confirmed" }]).catch(() => null);
      txs++;
      if (!tx?.meta?.logMessages) { broken = true; continue; }
      const e = positionEvents(tx.meta.logMessages, pool.id, p);
      broken ||= e.truncated;
      decreases += e.decreases;
      evs.push({ t: s.blockTime * 1000, create: e.create, delta: e.delta });
    }
    const anchored = !!old || evs.some((e) => e.create !== undefined);
    let L = old ? BigInt(old.steps.at(-1)![1]) : anchored ? 0n : p.raw!.liq - evs.reduce((a, e) => a + e.delta, 0n);
    const steps: [number, number][] = old ? [...old.steps] : anchored ? [] : [[openedAt, Number(L)]];
    for (const e of evs) {
      if (e.create !== undefined) L = e.create;
      L += e.delta;
      if (steps.at(-1)?.[1] !== Number(L)) steps.push([e.t, Number(L)]);
    }
    const ok = !broken && L >= 0n && (!anchored || L === p.raw!.liq);
    out[p.pda!] = { lastSig: sigs[0]?.signature ?? old!.lastSig, openedAt, steps: steps.length ? steps : [[openedAt, p.liquidity]], decreases, ok, fp };
    if (++done % 100 === 0) log(`  history ${done}/${ps.length} (${txs} txs decoded)`);
  });
  return out;
}

// Wallet holding each position NFT. getTokenLargestAccounts is switched off on the public RPC (method limit 0), so:
// mint -> token program (getMultipleAccounts), then that program's accounts for the mint (memcmp@0, indexed) with amount 1.
export async function owners(nfts: string[]): Promise<Map<string, string>> {
  const prog = new Map<string, string>();
  for (let i = 0; i < nfts.length; i += 100) {
    const r: any = await rpc("getMultipleAccounts", [nfts.slice(i, i + 100), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    r.value.forEach((v: any, k: number) => v && prog.set(nfts[i + k], v.owner));
  }
  const out = new Map<string, string>();
  await mapLimit(nfts.filter((m) => prog.has(m)), 4, async (m) => {
    const legacy = prog.get(m) === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const r: any[] = await rpc("getProgramAccounts", [prog.get(m), { encoding: "jsonParsed", filters: [...(legacy ? [{ dataSize: 165 }] : []), { memcmp: { offset: 0, bytes: m } }] }]);
    const o = r.find((a) => a.account.data.parsed?.info?.tokenAmount?.amount === "1")?.account.data.parsed.info.owner;
    if (o) out.set(m, o);
  });
  return out;
}

const M128 = 1n << 128n, DYNAMIC_TICK_ARRAY = "6a8b98247599b838";
const wrap = (x: bigint) => ((x % M128) + M128) % M128;
// Uniswap-v3 fee-inside: below/above from the ticks' fee_growth_outside relative to the current tick.
export function feeInside(g: bigint, lo: bigint, hi: bigint, tick: number, lower: number, upper: number) {
  const below = tick >= lower ? lo : wrap(g - lo);
  const above = tick < upper ? hi : wrap(g - hi);
  return wrap(g - below - above);
}

/**
 * Exact uncollected fees per position (raw token amounts): token_fees_owed + (fee_growth_inside now - last) * L >> 64.
 * PoolState fee_growth_global_{0,1} u128@277/@293, tick_current@269; TickArray PDA ['tick_array', pool, start i32 BE],
 * ticks@44 stride 168, fee_growth_outside_{0,1} at +36/+52. A tick whose stored index doesn't match is skipped.
 * ponytail: the dynamic-array header's offset map is not decoded; its ticks are found by a linear scan (<= 60 entries).
 */
export async function feesOwed(pool: Pool, ps: Position[]): Promise<Map<string, [bigint, bigint]>> {
  const pb = Buffer.from((await rpc<any>("getAccountInfo", [pool.id, { encoding: "base64" }])).value.data[0], "base64");
  const g0 = u128(pb, 277), g1 = u128(pb, 293), tick = pb.readInt32LE(269);
  const span = pool.tickSpacing * 60, start = (t: number) => Math.floor(t / span) * span;
  const starts = [...new Set(ps.flatMap((p) => [start(p.lower), start(p.upper)]))];
  const enc = getAddressEncoder();
  const pdas = await Promise.all(starts.map(async (s) => {
    const be = Buffer.alloc(4);
    be.writeInt32BE(s);
    return (await getProgramDerivedAddress({ programAddress: address(pool.program!), seeds: ["tick_array", enc.encode(address(pool.id)), be] }))[0];
  }));
  const arrays = new Map<number, Buffer>();
  for (let i = 0; i < pdas.length; i += 100) {
    const r: any = await rpc("getMultipleAccounts", [pdas.slice(i, i + 100), { encoding: "base64" }]);
    r.value.forEach((v: any, k: number) => v && arrays.set(starts[i + k], Buffer.from(v.data[0], "base64")));
  }
  const tickAt = (t: number) => {
    const b = arrays.get(start(t));
    if (!b) return;
    let o = 44 + ((t - start(t)) / pool.tickSpacing) * 168;
    // Dynamic tick arrays (Byreal, disc 6a8b98…): 216-byte header, then only the allocated ticks, unordered, same 168-byte TickState
    if (b.subarray(0, 8).toString("hex") === DYNAMIC_TICK_ARRAY) for (o = 216; o + 168 <= b.length && b.readInt32LE(o) !== t; o += 168);
    return b.length >= o + 168 && b.readInt32LE(o) === t ? [u128(b, o + 36), u128(b, o + 52)] : undefined;
  };
  // positions re-read now, next to the ticks: one read earlier in the run can be stale (closed or changed since)
  const fresh = new Map<string, Buffer>();
  for (let i = 0; i < ps.length; i += 100) {
    const chunk = ps.slice(i, i + 100);
    const r: any = await rpc("getMultipleAccounts", [chunk.map((p) => p.pda), { encoding: "base64" }]);
    r.value.forEach((v: any, k: number) => v && fresh.set(chunk[k].pda!, Buffer.from(v.data[0], "base64")));
  }
  const out = new Map<string, [bigint, bigint]>();
  for (const p of ps) {
    const b = fresh.get(p.pda!), lo = tickAt(p.lower), hi = tickAt(p.upper);
    if (!b || !lo || !hi) continue;
    const liq = u128(b, 81), d0 = wrap(feeInside(g0, lo[0], hi[0], tick, p.lower, p.upper) - u128(b, 97)), d1 = wrap(feeInside(g1, lo[1], hi[1], tick, p.lower, p.upper) - u128(b, 113));
    if (d0 >> 127n || d1 >> 127n) continue; // growth went "backwards": inconsistent snapshot, not a fee
    out.set(p.pda!, [b.readBigUInt64LE(129) + ((d0 * liq) >> 64n), b.readBigUInt64LE(137) + ((d1 * liq) >> 64n)]);
  }
  return out;
}
