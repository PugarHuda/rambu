// FairPrice: what one xStock token is worth right now, per Pyth + the mint's own multiplier,
// corrected for dividends that went ex but that the issuer has not yet folded into the multiplier.
import { address } from "@solana/kit";
import { feedOf, hermesId, mainnet, proPrice, pushPrice, sessionAt, type Px, type Sess } from "./pyth.ts";
import { UA } from "./sources.ts";

const DEFAULT_WHT = 0.3; // xStocks withholds 30% on US dividends in every recent CA (api.xstocks.fi corporate-actions)
const LIVE_MAX_AGE = 120_000; // a price older than this during an open session is stale
const CLOSED_MAX_AGE = 4 * 864e5; // while closed, the last print stays valid across a long weekend

export type Asset = { symbol: string; underlying: string; mint: string; issuerHalted: boolean; period: string };
export type CA = { symbol: string; type: string; effective: number; gross: number; net: number | null; wht: number | null };
export type Div = { exDate: number; amount: number };
export type Mint = { multiplier: number; newMultiplier: number; effective: number; paused: boolean };

export type Status = "Halted" | "Stale" | "CorpActionPending" | "Open" | "Closed";
export type Fair = {
  symbol: string; underlying: string; mint: string; session: Sess; issuerPeriod: string; status: Status; reasons: string[];
  mOnchain: number; px: (Px & { stale: boolean }) | null; pendingDiv: (Div & { net: number; wht: number }) | null;
  fairUi: number | null; fairRaw: number | null; naiveRaw: number | null;
  chainlinkRaw: number | null; dexRaw: number | null; naiveErrBp: number | null; chainlinkErrBp: number | null; dexErrBp: number | null;
};

// Effective multiplier by clock, exactly as Token-2022 ScaledUiAmount does it.
export const multiplierAt = (m: Mint, t: number) => (t >= m.effective ? m.newMultiplier : m.multiplier);

// Dividends already ex but with no issuer corporate action at/after the ex-date: still owed to the multiplier.
export function pendingDividend(divs: Div[], cas: CA[], now: number): Div | undefined {
  return divs
    .filter((d) => d.exDate <= now && now - d.exDate < 30 * 864e5)
    .filter((d) => !cas.some((c) => c.type === "CashDividend" && c.effective >= d.exDate - 2 * 864e5))
    .sort((a, b) => b.exDate - a.exDate)[0];
}

export const whtOf = (cas: CA[]) => cas.filter((c) => c.wht != null).sort((a, b) => b.effective - a.effective)[0]?.wht ?? DEFAULT_WHT;

// Core math, pure so it can be checked against today's SPYx numbers.
export function price(pxUnderlying: number, m: number, pending?: { net: number }) {
  const fairUi = pxUnderlying + (pending?.net ?? 0); // one UI unit = one share-equivalent; an unapplied dividend is still owed
  return { fairUi, fairRaw: fairUi * m, naiveRaw: pxUnderlying * m };
}

export const bp = (a: number | null, b: number | null) => (a && b ? (a / b - 1) * 1e4 : null);

export function statusOf(o: { issuerHalted: boolean; paused: boolean; px: { stale: boolean } | null; pending: boolean; session: Sess }): { status: Status; reasons: string[] } {
  const reasons: string[] = [];
  if (o.issuerHalted) reasons.push("issuer halt");
  if (o.paused) reasons.push("mint paused");
  if (reasons.length) return { status: "Halted", reasons };
  if (!o.px || o.px.stale) return { status: "Stale", reasons: ["no fresh underlying price"] };
  if (o.pending) return { status: "CorpActionPending", reasons: ["dividend ex, multiplier not stepped"] };
  return { status: o.session === "closed" ? "Closed" : "Open", reasons };
}

// ---- data sources ----

export async function readMint(mint: string): Promise<Mint> {
  const a: any = await mainnet.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
  const ext: any[] = a.value?.data?.parsed?.info?.extensions ?? [];
  const s = ext.find((e) => e.extension === "scaledUiAmountConfig")?.state;
  const p = ext.find((e) => e.extension === "pausableConfig")?.state;
  return { multiplier: Number(s?.multiplier ?? 1), newMultiplier: Number(s?.newMultiplier ?? s?.multiplier ?? 1), effective: Number(s?.newMultiplierEffectiveTimestamp ?? 0) * 1000, paused: !!p?.paused };
}

const TTL = 10 * 60e3; // long-running keeper: refetch issuer CAs / lender oracles every 10 minutes
let caCache: { at: number; v: CA[] } | undefined;
export async function corporateActions(): Promise<CA[]> {
  if (caCache && Date.now() - caCache.at < TTL) return caCache.v;
  const out: CA[] = [];
  for (let page = 1; page < 100; page++) {
    const j: any = await (await fetch(`https://api.xstocks.fi/api/v2/public/corporate-actions/upcoming?page=${page}`, { headers: { "user-agent": UA } })).json();
    for (const n of j.nodes ?? []) out.push({ symbol: n.xstockSymbol, type: n.caType, effective: Date.parse(n.effectiveTimeUtc), gross: Number(n.grossCashflowUsd ?? 0), net: n.netCashflowUsd == null ? null : Number(n.netCashflowUsd), wht: n.withholdingTaxRate == null ? null : Number(n.withholdingTaxRate) });
    if (!j.page?.hasNextPage) break;
  }
  caCache = { at: Date.now(), v: out };
  return out;
}

// ponytail: Yahoo chart API is unofficial; swap for a licensed corporate-actions feed before production.
export async function dividends(ticker: string): Promise<Div[]> {
  const j: any = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=3mo&interval=1d&events=div`, { headers: { "user-agent": "Mozilla/5.0" } })).json();
  const d = j.chart?.result?.[0]?.events?.dividends ?? {};
  return Object.values(d).map((x: any) => ({ exDate: x.date * 1000, amount: Number(x.amount) }));
}

let lendCache: { at: number; v: any[] } | undefined;
async function chainlinkRaw(mint: string): Promise<number | null> {
  if (!lendCache || Date.now() - lendCache.at > TTL) lendCache = { at: Date.now(), v: await (await fetch("https://lite-api.jup.ag/lend/v1/borrow/vaults")).json() };
  const v = lendCache.v.find((x) => x.supplyToken?.address === mint && x.oracleSources?.some((s: any) => "chainlinkDataStreams" in s.sourceType));
  return v ? Number(v.oraclePrice) / 1e15 : null; // Jupiter Lend scales every oracle to whole-token price × 1e15
}

async function dexUi(mint: string): Promise<{ ui: number | null; mark: number | null }> {
  const j: any = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`)).json();
  return { ui: j[mint]?.usdPrice ?? null, mark: j[mint]?.stockData?.price ?? null };
}

async function underlyingPx(ticker: string, session: Sess, now: number, mark: number | null): Promise<(Px & { stale: boolean }) | null> {
  const maxAge = session === "closed" ? CLOSED_MAX_AGE : LIVE_MAX_AGE;
  const tag = (p: Px) => ({ ...p, stale: now - p.publishTime > maxAge });
  const feed = await feedOf(ticker);
  const pro = await proPrice(feed.lazerId).catch(() => undefined);
  if (pro) return tag(pro);
  const id = await hermesId(feed.symbol);
  const push = id ? await pushPrice(id) : undefined;
  if (push && !tag(push).stale) return tag(push);
  // Last resort: issuer's underlying mark via Jupiter. Labeled, never silently treated as Pyth.
  if (mark) return { price: mark, conf: 0, publishTime: now, source: push ? `xstocks-mark (pyth-push stale since ${new Date(push.publishTime).toISOString().slice(0, 10)})` : "xstocks-mark", stale: false };
  return push ? tag(push) : null;
}

export async function fairPrice(a: Asset, now = Date.now()): Promise<Fair> {
  const feed = await feedOf(a.underlying);
  const session = sessionAt(feed.schedule, now);
  const [mint, cas, divs, dex, cl] = await Promise.all([readMint(a.mint), corporateActions(), dividends(a.underlying), dexUi(a.mint), chainlinkRaw(a.mint)]);
  const mine = cas.filter((c) => c.symbol === a.symbol);
  const div = pendingDividend(divs, mine, now);
  const wht = whtOf(mine);
  const pendingDiv = div ? { ...div, wht, net: div.amount * (1 - wht) } : null;
  const px = await underlyingPx(a.underlying, session, now, dex.mark);
  const m = multiplierAt(mint, now);
  const p = px ? price(px.price, m, pendingDiv ?? undefined) : null;
  const dexRaw = dex.ui ? dex.ui * m : null;
  const { status, reasons } = statusOf({ issuerHalted: a.issuerHalted, paused: mint.paused, px, pending: !!pendingDiv, session });
  return {
    symbol: a.symbol, underlying: a.underlying, mint: a.mint, session, issuerPeriod: a.period, status, reasons,
    mOnchain: m, px, pendingDiv,
    fairUi: p?.fairUi ?? null, fairRaw: p?.fairRaw ?? null, naiveRaw: p?.naiveRaw ?? null,
    chainlinkRaw: cl, dexRaw,
    naiveErrBp: bp(p?.naiveRaw ?? null, p?.fairRaw ?? null), chainlinkErrBp: bp(cl, p?.fairRaw ?? null), dexErrBp: bp(dexRaw, p?.fairRaw ?? null),
  };
}
