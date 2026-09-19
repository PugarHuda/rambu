// Offchain sources -> normalized per-stock state. No deps: Node 26 fetch + type stripping.

export const UA = process.env.SEC_UA ?? "Rambu keeper"; // SEC wants a contact email here: set SEC_UA in .env

// const objects, not enums: Node's type stripping can't run enums. Values mirror the onchain u8 codes.
export const Session = { Unknown: 0, Pre: 1, Regular: 2, Post: 3, Overnight: 4, Closed: 5 } as const;
export const Halt = { None: 0, Hard: 1, Soft: 2, Issuer: 3 } as const;
export const Event = { None: 0, Merger: 1, Tender: 2, Delisting: 3, Bankruptcy: 4, ControlChange: 5 } as const;
export type Session = (typeof Session)[keyof typeof Session];
export type Halt = (typeof Halt)[keyof typeof Halt];
export type Event = (typeof Event)[keyof typeof Event];

export type ExchangeHalt = { symbol: string; market: string; code: string; haltAt: number; resumeAt: number };
export type XStock = { symbol: string; underlying: string; mint: string; issuerHalted: boolean; period: string };
export type PendingEvent = { ticker: string; kind: Event; form: string; accession: string; filedAt: number };

// Nasdaq halt reason codes. Soft = volatility pauses that auto-resume; everything else blocks until resumption.
const SOFT = new Set(["LUDP", "LUDS", "M"]);
export const haltKind = (code: string) => (SOFT.has(code) ? Halt.Soft : Halt.Hard);

// "09/14/2026" + "19:50:00.000" in America/New_York -> epoch ms
export function etToUtc(date: string, time: string): number {
  if (!date?.trim() || !time?.trim()) return 0;
  const [m, d, y] = date.trim().split("/").map(Number);
  const [hh, mm, ss] = time.trim().split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, Math.floor(ss || 0));
  // offset of New York at that instant (handles DST)
  const ny = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  return guess + (utc.getTime() - ny.getTime());
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<ndaq:${name}>([^<]*)</ndaq:${name}>`))?.[1]?.trim() ?? "";

export function parseHalts(xml: string): ExchangeHalt[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    symbol: tag(it, "IssueSymbol"),
    market: tag(it, "Market"),
    code: tag(it, "ReasonCode"),
    haltAt: etToUtc(tag(it, "HaltDate"), tag(it, "HaltTime")),
    resumeAt: etToUtc(tag(it, "ResumptionDate"), tag(it, "ResumptionTradeTime")),
  }));
}

// Latest halt per symbol that is still active at `now` (no trade resumption yet, or resumption in the future).
export function activeHalts(halts: ExchangeHalt[], now = Date.now()): Map<string, ExchangeHalt> {
  const out = new Map<string, ExchangeHalt>();
  for (const h of halts.sort((a, b) => a.haltAt - b.haltAt)) {
    if (h.resumeAt && h.resumeAt <= now) out.delete(h.symbol);
    else out.set(h.symbol, h);
  }
  return out;
}

export async function fetchHalts(): Promise<ExchangeHalt[]> {
  const r = await fetch("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts", { headers: { "user-agent": UA } });
  return parseHalts(await r.text());
}

export async function fetchXStocks(): Promise<XStock[]> {
  const seen = new Map<string, XStock>();
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`https://api.xstocks.fi/api/v2/public/assets?network=Solana&page=${page}`, { headers: { "user-agent": UA } });
    const j: any = await r.json();
    for (const n of j.nodes ?? []) {
      const mint = n.deployments?.find((d: any) => d.network === "Solana")?.address;
      if (!mint) continue;
      // ponytail: issuer API disagrees with itself (asset vs trading flag), treat either as halted
      seen.set(n.symbol, { symbol: n.symbol, underlying: n.underlyingSymbol, mint, issuerHalted: !!(n.isTradingHalted || n.trading?.isTradingHalted), period: n.trading?.currentPeriod ?? "" });
    }
    if (!j.page?.hasNextPage) break;
  }
  return [...seen.values()];
}

export function sessionOf(period: string, now = Date.now()): Session {
  if (period === "market") return Session.Regular;
  if (period === "overnight") return Session.Overnight;
  if (period === "closed") return Session.Closed;
  if (period === "extended") {
    const h = Number(new Date(now).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
    return h < 12 ? Session.Pre : Session.Post;
  }
  return Session.Unknown;
}

// SEC forms / 8-K items that mean "the security itself is about to change".
export function eventOf(form: string, items: string): Event {
  if (/^SC TO-[TI]|^SC 14D9/.test(form)) return Event.Tender;
  if (/^(DEFM14A|PREM14A|S-4)$/.test(form)) return Event.Merger;
  if (/^(25|25-NSE|15-12B|15-12G)$/.test(form)) return Event.Delisting;
  if (form === "8-K") {
    const it = items.split(",");
    if (it.includes("1.03")) return Event.Bankruptcy;
    if (it.includes("3.01")) return Event.Delisting;
    if (it.includes("2.01")) return Event.Merger;
    if (it.includes("5.01")) return Event.ControlChange;
  }
  return Event.None;
}

export async function fetchEvents(tickers: string[], sinceDays = 30): Promise<PendingEvent[]> {
  const map: any = await (await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "user-agent": UA } })).json();
  const cik = new Map<string, number>(Object.values(map).map((c: any) => [c.ticker, c.cik_str]));
  const since = Date.now() - sinceDays * 864e5, out: PendingEvent[] = [];
  for (const t of tickers) {
    const c = cik.get(t);
    if (!c) continue;
    const j: any = await (await fetch(`https://data.sec.gov/submissions/CIK${String(c).padStart(10, "0")}.json`, { headers: { "user-agent": UA } })).json();
    const r = j.filings.recent;
    for (let i = 0; i < r.form.length; i++) {
      const filedAt = Date.parse(r.acceptanceDateTime[i]);
      if (filedAt < since) break; // recent[] is newest-first
      const kind = eventOf(r.form[i], r.items[i] ?? "");
      if (kind) out.push({ ticker: t, kind, form: r.form[i], accession: r.accessionNumber[i], filedAt });
    }
    await new Promise((s) => setTimeout(s, 120)); // SEC fair-access: <10 req/s
  }
  return out;
}
