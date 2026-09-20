// FairPrice: what one xStock token is worth right now, per Pyth + the mint's own multiplier,
// corrected for dividends that went ex but that the issuer has not yet folded into the multiplier.
import { address } from "@solana/kit";
import { feedOf, hermesId, lastClose, mainnet, proPrice, pushPrice, pythTicker, sessionAt, type Px, type Schedule, type Sess } from "./pyth.ts";
import { UA } from "./sources.ts";

const DEFAULT_WHT = 0.3; // xStocks withholds 30% on US dividends in every recent CA (api.xstocks.fi corporate-actions)
const LIVE_MAX_AGE = 120_000; // a price older than this during an open session is stale
const CLOSED_MAX_AGE = 4 * 864e5; // lastClose never looks further back than a long weekend
const MIN_PUBLISHERS = 3; // Pyth's own min_pub for the regular session of US equities
const MAX_CONF_BP = 50; // Pyth confidence wider than this is not a price to liquidate on
const MAX_DIVERGE_BP = 2000; // fair vs the xStock's own market: beyond this one of the inputs is wrong (split, bad mark)
const DAY = 864e5;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type Asset = { symbol: string; underlying: string; mint: string; issuerHalted: boolean; period: string };
export type CA = {
  symbol: string; type: string; effective: number; gross: number; net: number | null; wht: number | null;
  fromUnits: number | null; toUnits: number | null; multiplierNew: number | null;
};
export type Div = { exDate: number; amount: number };
export type Split = { at: number; ratio: number };
export type Mint = { multiplier: number; newMultiplier: number; effective: number; paused: boolean };

export type Status = "Halted" | "Stale" | "CorpActionPending" | "Open" | "Closed";
export type Fair = {
  symbol: string; underlying: string; mint: string; session: Sess; issuerPeriod: string; status: Status; reasons: string[]; haltCode: string;
  mOnchain: number; px: (Px & { stale: boolean }) | null; pendingDiv: (Div & { net: number; wht: number }) | null;
  fairUi: number | null; fairRaw: number | null; naiveRaw: number | null;
  chainlinkRaw: number | null; dexRaw: number | null; naiveErrBp: number | null; chainlinkErrBp: number | null; dexErrBp: number | null;
};

// Effective multiplier by clock, exactly as Token-2022 ScaledUiAmount does it.
export const multiplierAt = (m: Mint, t: number) => (t >= m.effective ? m.newMultiplier : m.multiplier);

// Dividends already ex but not yet in the multiplier. Applied when either
//  - the mint stepped in [exDate-4d, now] (issuer-agnostic: works for Ondo mints with no xStocks CA feed), or
//  - an xStocks CashDividend CA took effect in [exDate-4d, now] (xStocks steps on the Saturday before a Monday ex-date).
// ponytail: the mint only remembers its last step, so a split step inside those 4 days also reads as "applied".
export function pendingDividend(divs: Div[], cas: CA[], now: number, mint?: Mint): Div | undefined {
  const applied = (t: number, d: Div) => t >= d.exDate - 4 * DAY && t <= now;
  return divs
    .filter((d) => d.exDate <= now && now - d.exDate < 30 * DAY)
    .filter((d) => !(mint && applied(mint.effective, d)))
    .filter((d) => !cas.some((c) => c.type === "CashDividend" && applied(c.effective, d)))
    .sort((a, b) => b.exDate - a.exDate)[0];
}

const UNIT_CHANGE = new Set(["ForwardSplit", "ReverseSplit", "StockDividend"]);
const STRUCTURAL = new Set(["SpinOff", "StockMerger"]);
const inWindow = (t: number, now: number) => t >= now - 3 * DAY && t <= now + DAY;

// A unit change due within a day or done in the last 3 days, while the mint has not stepped since the day before it:
// the underlying already prints split-adjusted but the multiplier does not, so fair would be off by the split ratio.
export function splitPending(splits: Split[], cas: CA[], mint: Mint, now: number): Split | undefined {
  const all = [...splits, ...cas.filter((c) => UNIT_CHANGE.has(c.type)).map((c) => ({ at: c.effective, ratio: (c.toUnits ?? 1) / (c.fromUnits ?? 1) }))];
  return all.find((s) => inWindow(s.at, now) && !(mint.effective >= s.at - DAY && mint.effective <= now));
}

export const structuralCA = (cas: CA[], now: number) => cas.find((c) => STRUCTURAL.has(c.type) && inWindow(c.effective, now));

export const whtOf = (cas: CA[]) =>
  cas.filter((c) => c.type === "CashDividend" && c.wht != null).sort((a, b) => b.effective - a.effective)[0]?.wht ?? DEFAULT_WHT;

// Core math, pure so it can be checked against today's SPYx numbers.
export function price(pxUnderlying: number, m: number, pending?: { net: number }) {
  const fairUi = pxUnderlying + (pending?.net ?? 0); // one UI unit = one share-equivalent; an unapplied dividend is still owed
  return { fairUi, fairRaw: fairUi * m, naiveRaw: pxUnderlying * m };
}

export const bp = (a: number | null, b: number | null) => (a && b ? (a / b - 1) * 1e4 : null);

// Open session: the print must be under 2 minutes old. Closed: it must be the print the feed had when it closed.
export function isStale(publishTime: number, session: Sess, schedule: Schedule, now: number) {
  const since = session === "closed" ? Math.min(lastClose(schedule, now, CLOSED_MAX_AGE), now) : now;
  return publishTime < since - LIVE_MAX_AGE;
}

type StatusIn = {
  issuerHalted: boolean; paused: boolean; px: { stale: boolean; price?: number; conf?: number; publishers?: number } | null; pending: boolean; session: Sess;
  split?: boolean; structural?: string; dexErrBp?: number | null; caDown?: boolean; notes?: string[];
};
// First match wins: halts, then price quality, then corporate actions. haltCode is what the keeper writes onchain.
export function statusOf(o: StatusIn): { status: Status; reasons: string[]; haltCode: string } {
  const out = (status: Status, haltCode: string, ...r: string[]) => ({ status, haltCode, reasons: [...r, ...(o.notes ?? [])] });
  // ponytail: issuerHalted is the xStocks asset-level isTradingHalted flag, not the off-hours period. On Sat 19 Sep 2026 only
  // 7 of ~928 assets carried it (QQQx, IWMx among them) while SPYx/AAPLx in the same closed period did not, so it is a real
  // issuer pause and stays Halted (freezes liquidations) even on weekends. Weekend closure alone maps to Closed below.
  if (o.issuerHalted) return out("Halted", "ISSR", "issuer halt", ...(o.paused ? ["mint paused"] : []));
  if (o.paused) return out("Halted", "PAUS", "mint paused");
  if (o.structural) return out("Halted", "CORP", `${o.structural} in window`);
  if (!o.px || o.px.stale) return out("Stale", "STAL", "no fresh underlying price");
  if (o.px.publishers != null && o.px.publishers < MIN_PUBLISHERS) return out("Stale", "STAL", "low publishers");
  if (o.px.price && o.px.conf && (o.px.conf / o.px.price) * 1e4 > MAX_CONF_BP) return out("Stale", "STAL", "wide confidence");
  if (o.split) return out("CorpActionPending", "SPLT", "split pending, multiplier not stepped");
  if (o.dexErrBp != null && Math.abs(o.dexErrBp) > MAX_DIVERGE_BP) return out("Stale", "STAL", "fair vs market diverged");
  if (o.caDown) return out("CorpActionPending", "DIV", "dividend source down");
  if (o.pending) return out("CorpActionPending", "DIV", "dividend ex, multiplier not stepped");
  return out(o.session === "closed" ? "Closed" : "Open", "");
}

// xStocks trading.currentPeriod -> the Pyth session family it should agree with
const PERIOD: Record<string, Sess[]> = { market: ["regular"], extended: ["pre", "post"], overnight: ["overnight"], closed: ["closed"] };

// ---- data sources ----

// Fail closed: a mint we cannot read, that is not Token-2022, or that has no ScaledUiAmount has no trustworthy multiplier.
// Every tokenized stock we price (xStocks, Ondo) carries scaledUiAmountConfig, even at multiplier 1 (TSLAx).
export async function readMint(mint: string): Promise<Mint> {
  const a: any = await mainnet.getAccountInfo(address(mint), { encoding: "jsonParsed" }).send();
  if (!a.value) throw new Error(`mint ${mint} not found`);
  if (a.value.owner !== TOKEN_2022) throw new Error(`mint ${mint} not Token-2022 (${a.value.owner})`);
  const ext: any[] = a.value.data?.parsed?.info?.extensions ?? [];
  const s = ext.find((e) => e.extension === "scaledUiAmountConfig")?.state;
  if (!s) throw new Error(`mint ${mint} has no scaledUiAmountConfig`);
  const p = ext.find((e) => e.extension === "pausableConfig")?.state;
  return { multiplier: Number(s.multiplier), newMultiplier: Number(s.newMultiplier ?? s.multiplier), effective: Number(s.newMultiplierEffectiveTimestamp ?? 0) * 1000, paused: !!p?.paused };
}

const TTL = 10 * 60e3; // long-running keeper: refetch issuer CAs / lender oracles every 10 minutes
const num = (x: any) => (x == null ? null : Number(x));

// Raw corporate-actions nodes -> CAs: latest version per event, cancelled and undated versions dropped.
export function parseCAs(nodes: any[]): CA[] {
  const latest = new Map<string, any>();
  for (const n of nodes) if (!latest.has(n.eventId) || n.version > latest.get(n.eventId).version) latest.set(n.eventId, n);
  return [...latest.values()]
    .filter((n) => n.status !== "Cancelled" && n.effectiveTimeUtc != null)
    .map((n) => ({
      symbol: n.xstockSymbol, type: n.caType, effective: Date.parse(n.effectiveTimeUtc), gross: Number(n.grossCashflowUsd ?? 0),
      net: num(n.netCashflowUsd), wht: num(n.withholdingTaxRate), fromUnits: num(n.fromUnits), toUnits: num(n.toUnits), multiplierNew: num(n.multiplierNew),
    }));
}

let caCache: { at: number; v: CA[] } | undefined;
export async function corporateActions(): Promise<CA[]> {
  if (caCache && Date.now() - caCache.at < TTL) return caCache.v;
  try {
    const nodes: any[] = [];
    for (let page = 1; page < 100; page++) {
      const r = await fetch(`https://api.xstocks.fi/api/v2/public/corporate-actions/upcoming?page=${page}&pageSize=100`, { headers: { "user-agent": UA } });
      if (!r.ok) throw new Error(`xstocks corporate-actions ${r.status}`);
      const j: any = await r.json();
      if (!Array.isArray(j.nodes)) throw new Error("xstocks corporate-actions: no nodes");
      nodes.push(...j.nodes);
      if (!j.page?.hasNextPage) break;
    }
    caCache = { at: Date.now(), v: parseCAs(nodes) }; // only a complete walk replaces the cache
  } catch (e) {
    if (!caCache) throw e; // keep serving the last complete list while the issuer API is down
  }
  return caCache.v;
}

// Yahoo stamps an ex-date at the 09:30 ET open. The price goes ex when Pyth's overnight session opens, 20:00 ET the evening
// before, which is 13.5h earlier in both EDT and EST (checked on SPY 2024-2026: 13:30Z in summer, 14:30Z in winter).
export const exDateOf = (yahooDate: number) => yahooDate * 1000 - 13.5 * 36e5;

// ponytail: Yahoo chart API is unofficial; swap for a licensed corporate-actions feed before production.
const yCache = new Map<string, { at: number; v: { divs: Div[]; splits: Split[] } }>();
export async function yahooEvents(ticker: string): Promise<{ divs: Div[]; splits: Split[] }> {
  const t = pythTicker(ticker), c = yCache.get(t);
  if (c && Date.now() - c.at < TTL) return c.v;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?range=3mo&interval=1d&events=div,splits`, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`yahoo ${r.status}`);
    const j: any = await r.json();
    if (!j.chart?.result?.[0]) throw new Error(`yahoo: no chart for ${t}`);
    const e = j.chart.result[0].events ?? {};
    const v = {
      divs: Object.values(e.dividends ?? {}).map((x: any) => ({ exDate: exDateOf(x.date), amount: Number(x.amount) })),
      splits: Object.values(e.splits ?? {}).map((x: any) => ({ at: x.date * 1000, ratio: x.numerator / x.denominator })),
    };
    yCache.set(t, { at: Date.now(), v });
    return v;
  } catch (e) {
    if (c) return c.v;
    throw e;
  }
}
export const dividends = async (ticker: string) => (await yahooEvents(ticker)).divs;

let lendCache: { at: number; v: any[] } | undefined;
async function chainlinkRaw(mint: string): Promise<number | null> {
  if (!lendCache || Date.now() - lendCache.at > TTL) {
    const r = await fetch("https://lite-api.jup.ag/lend/v1/borrow/vaults");
    if (!r.ok) throw new Error(`jupiter lend ${r.status}`);
    lendCache = { at: Date.now(), v: await r.json() };
  }
  const v = lendCache.v.find((x) => x.supplyToken?.address === mint && x.oracleSources?.some((s: any) => "chainlinkDataStreams" in s.sourceType));
  return v ? Number(v.oraclePrice) / 1e15 : null; // Jupiter Lend scales every oracle to whole-token price × 1e15
}

// markAt is when Jupiter last refreshed the issuer's mark, not the underlying's last trade: the best timestamp on offer.
async function dexUi(mint: string): Promise<{ ui: number | null; mark: number | null; markAt: number }> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`);
  if (!r.ok) throw new Error(`jupiter price ${r.status}`);
  const j: any = await r.json();
  return { ui: j[mint]?.usdPrice ?? null, mark: j[mint]?.stockData?.price ?? null, markAt: Date.parse(j[mint]?.stockData?.updatedAt ?? "") || 0 };
}

async function underlyingPx(ticker: string, session: Sess, now: number, dex: { mark: number | null; markAt: number }): Promise<(Px & { stale: boolean }) | null> {
  const feed = await feedOf(ticker);
  // Pyth Pro's own marketSession outranks our calendar when judging its print
  const tag = (p: Px) => ({ ...p, stale: isStale(p.publishTime, p.session ?? session, feed.schedule, now) });
  let proErr = "";
  const pro = await proPrice(feed.lazerId).catch((e) => { proErr = / 403/.test(e.message) ? "pyth-pro not entitled" : "pyth-pro error"; return undefined; });
  if (pro) return tag(pro);
  const id = feed.hermesId ?? (await hermesId(feed.symbol));
  const push = id ? await pushPrice(id).catch(() => undefined) : undefined;
  if (push && !tag(push).stale) return tag(push);
  // Last resort: issuer's underlying mark via Jupiter. Labeled, never silently treated as Pyth, and aged by its own timestamp.
  const why = [proErr, push ? `pyth-push stale since ${new Date(push.publishTime).toISOString().slice(0, 10)}` : ""].filter(Boolean).join("; ");
  if (dex.mark) return tag({ price: dex.mark, conf: 0, publishTime: dex.markAt, source: `xstocks-mark (${why})` });
  return push ? tag(push) : null;
}

const val = <T,>(r: PromiseSettledResult<T>, fallback: T) => (r.status === "fulfilled" ? r.value : fallback);

export async function fairPrice(a: Asset, now = Date.now()): Promise<Fair> {
  const feed = await feedOf(a.underlying);
  // Only the mint and the underlying price are critical; everything else degrades.
  const [mintR, casR, yR, dexR, clR] = await Promise.allSettled([readMint(a.mint), corporateActions(), yahooEvents(a.underlying), dexUi(a.mint), chainlinkRaw(a.mint)]);
  if (mintR.status === "rejected") throw mintR.reason;
  const mint = mintR.value;
  const dex = val(dexR, { ui: null, mark: null, markAt: 0 });
  const cl = val(clR, null);
  const mine = val(casR, [] as CA[]).filter((c) => c.symbol === a.symbol);
  const { divs, splits } = val(yR, { divs: [] as Div[], splits: [] as Split[] });
  const caDown = casR.status === "rejected" || yR.status === "rejected";

  const div = pendingDividend(divs, mine, now, mint);
  const wht = whtOf(mine);
  const pendingDiv = div ? { ...div, wht, net: div.amount * (1 - wht) } : null;
  const px = await underlyingPx(a.underlying, sessionAt(feed.schedule, now), now, dex);
  const session = px?.session ?? sessionAt(feed.schedule, now);
  const notes = a.period && PERIOD[a.period] && !PERIOD[a.period].includes(session) ? [`pyth session ${session} != issuer period ${a.period}`] : [];
  const m = multiplierAt(mint, now);
  const p = px ? price(px.price, m, pendingDiv ?? undefined) : null;
  const dexRaw = dex.ui ? dex.ui * m : null;
  const dexErrBp = bp(dexRaw, p?.fairRaw ?? null);
  const st = structuralCA(mine, now);
  const { status, reasons, haltCode } = statusOf({
    issuerHalted: a.issuerHalted, paused: mint.paused, px, pending: !!pendingDiv, session,
    split: !!splitPending(splits, mine, mint, now), structural: st?.type, dexErrBp, caDown, notes,
  });
  return {
    symbol: a.symbol, underlying: a.underlying, mint: a.mint, session, issuerPeriod: a.period, status, reasons, haltCode,
    mOnchain: m, px, pendingDiv,
    fairUi: p?.fairUi ?? null, fairRaw: p?.fairRaw ?? null, naiveRaw: p?.naiveRaw ?? null,
    chainlinkRaw: cl, dexRaw,
    naiveErrBp: bp(p?.naiveRaw ?? null, p?.fairRaw ?? null), chainlinkErrBp: bp(cl, p?.fairRaw ?? null), dexErrBp,
  };
}
