// Lender oracle exposure: what Kamino (Scope) and Jupiter Lend price each xStock at, vs FairPrice,
// how many dollars ride on that gap, and whether each lender's own guard fired. Plus the issuer
// cross-check (xStocks vs Ondo on the same underlying) and the Kamino vault curators funding it.
import { address, getAddressDecoder } from "@solana/kit";
import { bp, dividends, readMint, whtOf, type Fair } from "./fairprice.ts";
import { mainnet } from "./pyth.ts";

// ponytail: the onchain FairPrice band (BAND_BPS, 10%) is a manipulation guard; a lender mispricing a
// dividend is a much smaller gap. 10bp ~ half a quarterly SPY dividend net of WHT. Tune with LENDER_BAND_BP.
export const LENDER_BAND_BP = Number(process.env.LENDER_BAND_BP ?? 10);
const KAMINO_MARKETS = ["5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua", "8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr"]; // xStocks, Sentora xStocks
const b58 = getAddressDecoder();
const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json() as Promise<any>; };
const nowS = () => Date.now() / 1000;
// public mainnet RPC answers 429 under load (the Ondo history walk is ~100 getTransaction): back off 1s..32s
async function rpc<T>(f: () => Promise<T>, n = 7): Promise<T> {
  for (let k = 0; ; k++) {
    try { return await f(); } catch (e: any) {
      if (k + 1 >= n || !/429|Too Many|fetch failed/i.test(String(e?.message ?? e))) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** k));
    }
  }
}

// ---- Kamino klend Reserve (8624 bytes). Offsets checked against a live SPYx reserve; name + LTV guard drift. ----
const R = { ltv: 4872, lt: 4873, maxBonus: 4876, name: 5032, maxAge: 5096, scope: 5112, chain: 5144 };
export type Reserve = { name: string; ltv: number; lt: number; maxBonusBps: number; maxAgeS: number; scopeFeed: string; chain: number[] };
export function decodeReserve(b: Buffer, symbol: string, maxLtv?: number): Reserve {
  const name = b.subarray(R.name, R.name + 32).toString().replace(/\0+$/, "");
  if (name !== symbol) throw new Error(`kamino reserve name "${name}" != ${symbol}: layout drifted`);
  if (maxLtv != null && Math.round(maxLtv * 100) !== b[R.ltv]) throw new Error(`kamino reserve LTV ${b[R.ltv]} != API ${maxLtv}: layout drifted`);
  const chain = [0, 1, 2, 3].map((i) => b.readUInt16LE(R.chain + 2 * i)).filter((i) => i !== 0xffff);
  return { name, ltv: b[R.ltv] / 100, lt: b[R.lt] / 100, maxBonusBps: b.readUInt16LE(R.maxBonus), maxAgeS: Number(b.readBigUInt64LE(R.maxAge)), scopeFeed: b58.decode(b.subarray(R.scope, R.scope + 32)), chain };
}

// ---- Scope OraclePrices (entry i at 40+56i) + OracleMappings (types @16392, generic [u8;20] @19464) ----
export const TYPE: Record<number, string> = { 21: "PythPull", 26: "Chainlink", 28: "MostRecentOf", 29: "PythLazer", 33: "CappedFloored", 34: "ChainlinkRWA", 37: "ChainlinkX", 39: "CappedMostRecentOf", 43: "MultiplicationChain", 50: "Token2022Multiplier" };
const MAP_TYPES = 8 + 32 * 512, MAP_GENERIC = MAP_TYPES + 512 + 2 * 512 + 512 + 2 * 512, MAX_ENTRIES = 512;
export type Entry = { i: number; value: number; slot: number; ts: number; type: number; gen: Buffer; pgen: Buffer };
export type ScopeAt = (i: number) => Entry;

// prices/types/gen start at entry `base`, so a saved slice and the live account decode through the same code.
export const scopeView = (prices: Buffer, types: Buffer, gen: Buffer, base = 0): ScopeAt => (i) => {
  const k = i - base, o = 56 * k;
  if (k < 0 || o + 56 > prices.length) throw new Error(`scope entry ${i} outside slice`);
  return {
    i, value: Number(prices.readBigUInt64LE(o)) / 10 ** Number(prices.readBigUInt64LE(o + 8)), slot: Number(prices.readBigUInt64LE(o + 16)),
    ts: Number(prices.readBigUInt64LE(o + 24)), type: types[k], gen: gen.subarray(20 * k, 20 * k + 20), pgen: prices.subarray(o + 32, o + 56),
  };
};
export const scopeLive = (prices: Buffer, map: Buffer) => scopeView(prices.subarray(40), map.subarray(MAP_TYPES, MAP_TYPES + 512), map.subarray(MAP_GENERIC, MAP_GENERIC + 20 * 512));

// Follow composites down to the entry whose value Kamino actually ends up using.
export function effectiveLeg(at: ScopeAt, i: number, depth = 0): Entry {
  if (depth > 8) throw new Error("scope composite loop");
  const e = at(i);
  if (e.type === 33) { // CappedFloored { source u16, cap Option<u16>, floor Option<u16> } (Borsh)
    const src = e.gen.readUInt16LE(0);
    const cap = e.gen[2] ? e.gen.readUInt16LE(3) : undefined;
    const fo = cap === undefined ? 3 : 5, floor = e.gen[fo] ? e.gen.readUInt16LE(fo + 1) : undefined;
    if (cap !== undefined && cap === floor) return effectiveLeg(at, cap, depth + 1); // pinned: the source never wins
    const v = at(src).value;
    if (cap !== undefined && v > at(cap).value) return effectiveLeg(at, cap, depth + 1);
    if (floor !== undefined && v < at(floor).value) return effectiveLeg(at, floor, depth + 1);
    return effectiveLeg(at, src, depth + 1);
  }
  if (e.type === 28) { // MostRecentOf { sources [u16;4], max_divergence_bps u16, max_age_s u64 }: newest source wins
    const src = [0, 1, 2, 3].map((k) => e.gen.readUInt16LE(2 * k)).filter((k) => k < MAX_ENTRIES);
    return effectiveLeg(at, src.map(at).sort((a, b) => b.ts - a.ts)[0].i, depth + 1);
  }
  return e;
}

// ChainlinkX keeps { observations_ts u64, suspended bool, activation_date_time u64 } in the price's generic data.
export const chainlinkX = (e: Entry) => e.type === 37 ? { obs: Number(e.pgen.readBigUInt64LE(0)), suspended: e.pgen[8] === 1, activation: Number(e.pgen.readBigUInt64LE(9)) } : null;

export type Lender = {
  ticker: string; mint: string; protocol: "kamino" | "jupiter"; market: string; account: string; leg: string;
  priceRaw: number; fairRaw: number | null; fairSource: string | null; errBp: number | null; ageS: number; valueAgeS: number; maxAgeS: number | null;
  collateralUsd: number; borrowUsd: number; positions: number | null; lt: number; penalty: number | null;
  suspended: boolean | null; activation: number | null; misvalUsd: number | null; flags: string[];
};
export type Wrapper = { ticker: string; issuer: "xstocks" | "ondo"; mint: string; multiplier: number; stepAt: number | null; stepProof: string; lastExAt: number | null; lagDays: number | null; fairRaw: number | null; dexBp: number | null; liquidityUsd: number | null; paused: boolean };
export type Curator = { vault: string; name: string; market: string; reserve: string; xstockUsd: number; share: number };

async function accounts(keys: string[]): Promise<(Buffer | null)[]> {
  const out: (Buffer | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r: any = await rpc(() => mainnet.getMultipleAccounts(keys.slice(i, i + 100).map(address), { encoding: "base64" }).send());
    out.push(...r.value.map((a: any) => (a ? Buffer.from(a.data[0], "base64") : null)));
  }
  return out;
}

// Obligations per reserve: klend Obligation (3344 bytes) has lendingMarket @32 and 8 ObligationCollateral
// { depositReserve, depositedAmount u64, ... } of 136 bytes from @96. One getProgramAccounts per market, sliced.
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", OBL = { size: 3344n, market: 32n, deposits: 96, slot: 136 };
export function countDeposits(slices: Buffer[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const b of slices) for (let k = 0; k < 8; k++) {
    const o = OBL.slot * k;
    if (b.readBigUInt64LE(o + 32) > 0n) { const r = b58.decode(b.subarray(o, o + 32)); n.set(r, (n.get(r) ?? 0) + 1); }
  }
  return n;
}
async function positions(market: string): Promise<Map<string, number>> {
  const r: any = await rpc(() => mainnet.getProgramAccounts(address(KLEND), {
    encoding: "base64", dataSlice: { offset: OBL.deposits, length: 8 * OBL.slot },
    filters: [{ dataSize: OBL.size }, { memcmp: { offset: OBL.market, bytes: market as any, encoding: "base58" } }],
  }).send());
  return countDeposits(r.map((a: any) => Buffer.from(a.account.data[0], "base64")));
}

async function kamino(xMints: Set<string>) {
  const reserves: any[] = [], pos = new Map<string, number>();
  for (const m of KAMINO_MARKETS) {
    for (const r of await get(`https://api.kamino.finance/kamino-market/${m}/reserves/metrics`)) reserves.push({ ...r, market: m });
    for (const [k, v] of await positions(m)) pos.set(k, v);
  }
  const xs = reserves.filter((r) => xMints.has(r.liquidityTokenMint));
  const bufs = await accounts(xs.map((r) => r.reserve));
  const dec = xs.map((r, k) => { if (!bufs[k]) throw new Error(`kamino reserve ${r.reserve} missing`); return decodeReserve(bufs[k]!, r.liquidityToken, Number(r.maxLtv)); });
  const feeds = [...new Set(dec.map((d) => d.scopeFeed))], pbufs = await accounts(feeds);
  const maps = await accounts(pbufs.map((b) => b58.decode(b!.subarray(8, 40))));
  const scope = new Map(feeds.map((f, k) => [f, scopeLive(pbufs[k]!, maps[k]!)]));
  return {
    reserves, // every reserve in the xStocks markets (curators look up USDC/PYUSD reserves here)
    rows: xs.map((r, k) => {
      const d = dec[k], at = scope.get(d.scopeFeed)!;
      // ponytail: a price chain multiplies its entries; every xStock reserve today uses a single entry
      const top = at(d.chain[0]), leg = effectiveLeg(at, d.chain[0]), cl = chainlinkX(leg);
      return {
        mint: r.liquidityTokenMint as string, symbol: r.liquidityToken as string, market: r.market as string, account: r.reserve as string,
        leg: top.i === leg.i ? `#${leg.i} ${TYPE[leg.type] ?? leg.type}` : `#${top.i} ${TYPE[top.type] ?? top.type} -> #${leg.i} ${TYPE[leg.type] ?? leg.type}`,
        priceRaw: d.chain.reduce((p, i) => p * at(i).value, 1), ageS: nowS() - top.ts, valueAgeS: nowS() - leg.ts, maxAgeS: d.maxAgeS,
        collateralUsd: Number(r.totalSupplyUsd), borrowUsd: Number(r.totalBorrowUsd), positions: pos.get(r.reserve) ?? 0, lt: d.lt, penalty: d.maxBonusBps / 1e4,
        suspended: cl ? cl.suspended : null, activation: cl?.activation ? cl.activation * 1000 : null,
      };
    }),
  };
}

// Every xStock some lender takes as collateral: board prices these whatever TRACK says, so no lender row lacks a fair.
export async function lentMints(xMints: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const m of KAMINO_MARKETS) for (const r of await get(`https://api.kamino.finance/kamino-market/${m}/reserves/metrics`)) if (xMints.has(r.liquidityTokenMint)) out.add(r.liquidityTokenMint);
  for (const v of await get("https://lite-api.jup.ag/lend/v1/borrow/vaults")) if (xMints.has(v.supplyToken?.address)) out.add(v.supplyToken.address);
  return out;
}

async function jupiter(xMints: Set<string>) {
  const vaults: any[] = await get("https://lite-api.jup.ag/lend/v1/borrow/vaults");
  return vaults.filter((v) => xMints.has(v.supplyToken?.address)).map((v) => {
    const age = nowS() - Number(v.oracleTimestamp) / 1000;
    return {
      mint: v.supplyToken.address as string, symbol: v.supplyToken.symbol as string, market: `vault ${v.id} ${v.supplyToken.symbol}/${v.borrowToken.symbol}`, account: v.address as string,
      leg: v.oracleSources.map((s: any) => Object.keys(s.sourceType)[0]).join("+"),
      priceRaw: Number(v.oraclePriceLiquidate) / 1e15, // Jupiter Lend scales every oracle to whole-token price × 1e15
      ageS: age, valueAgeS: age, maxAgeS: null,
      collateralUsd: (Number(v.totalSupply) / 10 ** v.supplyToken.decimals) * Number(v.supplyToken.price),
      borrowUsd: (Number(v.totalBorrow) / 10 ** v.borrowToken.decimals) * Number(v.borrowToken.price),
      positions: Number(v.totalPositions), lt: Number(v.liquidationThreshold) / 1000, penalty: Number(v.liquidationPenalty) / 1000,
      suspended: v.oracleSources.some((s: any) => s.suspended), activation: null,
    };
  });
}

// Days a mint lagged (or is still lagging) the last ex-date within 30 days (pendingDividend's window).
// Stepped at/after the ex-date -> step minus ex; not yet -> days since ex, which keeps growing until the issuer acts.
// 3-day slack: issuers step on the Saturday before a Monday ex-date (AAPLx 8 Aug for 10 Aug).
export function lagOf(lastExAt: number | null, stepAt: number, now: number): { stepped: boolean; lagDays: number | null } {
  if (lastExAt == null || now - lastExAt > 30 * 864e5) return { stepped: true, lagDays: null };
  const stepped = stepAt <= now && stepAt >= lastExAt - 3 * 864e5;
  return { stepped, lagDays: Math.max(0, Math.floor(((stepped ? stepAt : now) - lastExAt) / 864e5)) };
}

// Ondo rewrites newMultiplierEffectiveTimestamp on every GM mint in one admin batch, value changed or not
// (18 Sep 17:54: TSLAon 1 -> 1 got the same stamp as SPYon), so the mint's own stamp can't date a dividend.
// The batch signer's history can: each tx carries Token-2022 updateMultiplier {mint, newMultiplier, ts}.
// ponytail: one known signer; a step signed by another key reads as unproven/no step until ONDO_ADMIN is updated.
export const ONDO_ADMIN = process.env.ONDO_ADMIN ?? "5AzscwfVv7bJtmtYNc41mM68gVFzQKjGoy64GZoukgGn";
export type Upd = { ts: number; m: number };
// updates newest first -> ts of the last real change, 0 when the value held since before `since`, undefined when unprovable
export function lastChange(ups: Upd[], since: number): number | undefined {
  if (!ups.length) return undefined;
  for (let k = 1; k < ups.length; k++) if (ups[k].m !== ups[0].m) return ups[k - 1].ts;
  return ups.at(-1)!.ts < since ? 0 : undefined; // never saw a value from before `since`: can't tell when it changed
}
export function multiplierUpdates(tx: any, mints: Set<string>): (Upd & { mint: string })[] {
  const ix = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions)];
  return ix.filter((i: any) => i.parsed?.type === "updateMultiplier" && mints.has(i.parsed.info?.mint))
    .map((i: any) => ({ mint: i.parsed.info.mint, ts: Number(i.parsed.info.newMultiplierTimestamp) * 1000, m: Number(i.parsed.info.newMultiplier) }));
}
// Walk the signer back until every mint has an update older than `since` (or MAX_TX signatures), newest first per mint.
async function ondoUpdates(mints: Set<string>, since: number, MAX_TX = 600): Promise<Map<string, Upd[]>> {
  const ups = new Map<string, Upd[]>([...mints].map((m) => [m, []]));
  const done = () => [...ups.values()].every((u) => u.length && u.at(-1)!.ts < since);
  let before: string | undefined, seen = 0;
  while (!done() && seen < MAX_TX) {
    const sigs: any[] = await rpc(() => mainnet.getSignaturesForAddress(address(ONDO_ADMIN), { limit: 100, ...(before ? { before: before as any } : {}) }).send());
    if (!sigs.length) break;
    before = sigs.at(-1).signature; seen += sigs.length;
    for (const s of sigs) {
      if (s.err) continue;
      const tx: any = await rpc(() => mainnet.getTransaction(s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send());
      if (tx) for (const u of multiplierUpdates(tx, mints)) ups.get(u.mint)!.push({ ts: u.ts, m: u.m });
    }
  }
  for (const u of ups.values()) u.sort((a, b) => b.ts - a.ts);
  return ups;
}

async function ondoMint(ticker: string): Promise<any> {
  const list: any[] = await get(`https://lite-api.jup.ag/tokens/v2/search?query=${ticker}on`);
  return list.find((t) => t.isVerified && t.symbol === `${ticker}on` && t.id.endsWith("ondo"));
}

async function wrappers(rows: Fair[], now: number) {
  const out: Wrapper[] = [], stepped = new Map<string, boolean>();
  const ondo = new Map<string, any>(), ex = new Map<string, { divs: any[]; lastExAt: number | null }>();
  for (const r of rows) {
    const t = await ondoMint(r.underlying).catch(() => undefined);
    if (t) ondo.set(r.underlying, t);
    const divs = await dividends(r.underlying).catch(() => []);
    ex.set(r.underlying, { divs, lastExAt: divs.filter((d) => d.exDate <= now).sort((a, b) => b.exDate - a.exDate)[0]?.exDate ?? null });
  }
  const dex: any = ondo.size ? await get(`https://lite-api.jup.ag/price/v3?ids=${[...ondo.values()].map((t) => t.id).join(",")}`) : {};
  // only Ondo mints with an ex-date in the window need dating; walk back to the earliest one minus the 3-day slack
  const inWindow = (at: number | null) => at != null && now - at <= 30 * 864e5;
  const need = [...ondo].filter(([u]) => inWindow(ex.get(u)!.lastExAt));
  const since = Math.min(...need.map(([u]) => ex.get(u)!.lastExAt! - 3 * 864e5));
  const oups = need.length ? await ondoUpdates(new Set(need.map(([, t]) => t.id as string)), since) : new Map<string, Upd[]>();
  for (const r of rows) {
    const { divs, lastExAt } = ex.get(r.underlying)!;
    const xm = await rpc(() => readMint(r.mint)), xl = lagOf(lastExAt, xm.effective, now);
    const xt: any = (await get(`https://lite-api.jup.ag/tokens/v2/search?query=${r.mint}`).catch(() => []))[0];
    stepped.set(r.mint, xl.stepped);
    // xStocks writes the stamp only when it steps (TSLAx: never), so the mint's own stamp is the step
    out.push({ ticker: r.underlying, issuer: "xstocks", mint: r.mint, multiplier: r.mOnchain, stepAt: xm.effective || null, stepProof: "mint effective timestamp (written only on a step)", lastExAt, lagDays: xl.lagDays, fairRaw: r.fairRaw, dexBp: r.dexErrBp, liquidityUsd: xt?.liquidity ?? null, paused: xm.paused });
    const t = ondo.get(r.underlying);
    if (!t) continue;
    const om = await rpc(() => readMint(t.id)), m = om.effective <= now ? om.newMultiplier : om.multiplier;
    const ch = !inWindow(lastExAt) ? undefined : lastChange(oups.get(t.id) ?? [], since);
    const ol = ch === undefined ? { stepped: true, lagDays: null } : lagOf(lastExAt, ch, now);
    // same underlying print as the xStock row; an ex-dividend Ondo has provably not folded yet is still owed (default WHT)
    const div = !ol.stepped && lastExAt ? divs.find((d) => d.exDate === lastExAt)!.amount * (1 - whtOf([])) : 0;
    const fairRaw = r.px ? (r.px.price + div) * m : null, ui = dex[t.id]?.usdPrice ?? null;
    const stepProof = !inWindow(lastExAt) ? "no ex-date in 30d" : ch === undefined ? "unproven: Ondo updateMultiplier history does not reach the ex-date"
      : ch === 0 ? `multiplier unchanged in Ondo batches since ${new Date(since).toISOString().slice(0, 10)}` : "multiplier changed in Ondo admin batch";
    out.push({ ticker: r.underlying, issuer: "ondo", mint: t.id, multiplier: m, stepAt: ch || null, stepProof, lastExAt, lagDays: ol.lagDays, fairRaw, dexBp: bp(ui ? ui * m : null, fairRaw), liquidityUsd: t.liquidity ?? null, paused: om.paused });
  }
  return { out, stepped };
}

async function curators(reserves: any[]): Promise<Curator[]> {
  const byReserve = new Map(reserves.map((r) => [r.reserve, r]));
  const vaults: any[] = await get("https://api.kamino.finance/kvaults/vaults");
  const out: Curator[] = [];
  for (const v of vaults) for (const a of v.state.vaultAllocationStrategy) {
    const r = byReserve.get(a.reserve);
    if (!r || a.ctokenAllocation === "0") continue;
    // ctokens -> tokens: the vault's ctoken balance over the collateral mint supply, times the reserve's supplied USD
    const ta: any = await rpc(() => mainnet.getAccountInfo(address(a.ctokenVault), { encoding: "jsonParsed" }).send());
    const cmint = ta.value.data.parsed.info.mint;
    const sup: any = await rpc(() => mainnet.getTokenSupply(address(cmint)).send());
    const usd = (Number(a.ctokenAllocation) / Number(sup.value.amount)) * Number(r.totalSupplyUsd);
    const m = await get(`https://api.kamino.finance/kvaults/${v.address}/metrics`);
    const aum = Number(m.tokensInvestedUsd) + Number(m.tokensAvailableUsd);
    out.push({ vault: v.address, name: v.state.name, market: r.market, reserve: a.reserve, xstockUsd: usd, share: aum ? usd / aum : 0 });
  }
  return out.sort((a, b) => b.xstockUsd - a.xstockUsd);
}

export function flagsOf(f: Fair | undefined, l: { errBp: number | null; suspended: boolean | null; ageS: number; maxAgeS: number | null }, stepped: boolean | undefined, band = LENDER_BAND_BP): string[] {
  const out: string[] = [], err = l.errBp == null ? null : Math.abs(l.errBp);
  if (f && (f.status === "CorpActionPending" || f.status === "Halted") && err != null && err > band) out.push("should suspend");
  // harm only when the price is off: Jupiter Chainlink already prices SPYx ex-div (-0.8bp), nothing to suspend for
  if (f?.pendingDiv && !l.suspended && err != null && err > band) out.push("dividend ex, lenders not suspended");
  if (l.suspended && stepped && err != null && err <= band) out.push("safe to resume");
  if (l.maxAgeS != null && l.ageS > l.maxAgeS) out.push("oracle older than lender max age");
  return out;
}

export async function lenders(rows: Fair[], xMints: Set<string>, now = Date.now()) {
  const [k, j, w] = await Promise.all([kamino(xMints), jupiter(xMints), wrappers(rows, now)]);
  const fair = new Map(rows.map((r) => [r.mint, r]));
  const all: Lender[] = [...k.rows.map((x) => ({ ...x, protocol: "kamino" as const })), ...j.map((x) => ({ ...x, protocol: "jupiter" as const }))].map(({ symbol, ...x }) => {
    const f = fair.get(x.mint), fairRaw = f?.fairRaw ?? null, errBp = bp(x.priceRaw, fairRaw);
    // fairSource: an "xstocks-mark" fair is the issuer mark, not an independent print; read errBp with that in mind
    const l = { ...x, ticker: symbol, fairRaw, fairSource: f ? (f.px?.source ?? null) : null, errBp, misvalUsd: errBp == null ? null : (x.collateralUsd * Math.abs(errBp)) / 1e4, flags: [] as string[] };
    l.flags = flagsOf(f, l, w.stepped.get(x.mint));
    return l;
  });
  return { lenders: all, wrappers: w.out, curators: await curators(k.reserves) };
}
