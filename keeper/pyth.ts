// Pyth plumbing: public session calendar (no key), onchain push accounts (no key), Pyth Pro latest price (needs PYTH_PRO_TOKEN).
import { address, createSolanaRpc, getProgramDerivedAddress } from "@solana/kit";

export const MAINNET = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
export const mainnet = createSolanaRpc(MAINNET);
const PUSH_ORACLE = address("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

export type Sess = "regular" | "pre" | "post" | "overnight" | "closed";
export type Schedule = Record<Exclude<Sess, "closed">, string>;
export type Feed = { lazerId: number; symbol: string; schedule: Schedule };

// "America/New_York;0930-1600,...x7 (Mon..Sun);MMDD/C,MMDD/0930-1300" -> is `t` inside the window?
export function inSchedule(spec: string, t: number): boolean {
  if (!spec) return false;
  const [tz, week, holidays = ""] = spec.split(";");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const hhmm = Number(p.hour) * 100 + Number(p.minute);
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  const override = holidays.split(",").find((h) => h.startsWith(`${p.month}${p.day}/`));
  const rule = override ? override.split("/")[1] : week.split(",")[day];
  if (rule === "O") return true;
  if (!rule || rule === "C") return false;
  // a rule may hold several ranges ("0000-0400&2000-2400")
  return rule.split("&").some((r) => {
    const [a, b] = r.split("-").map(Number);
    return a <= b ? hhmm >= a && hhmm < b : hhmm >= a || hhmm < b;
  });
}

export function sessionAt(s: Schedule, t: number): Sess {
  for (const k of ["regular", "pre", "post", "overnight"] as const) if (inSchedule(s[k], t)) return k;
  return "closed";
}

const feedCache = new Map<string, Feed>();
export async function feedOf(ticker: string): Promise<Feed> {
  const symbol = `Equity.US.${ticker}/USD`;
  if (feedCache.has(symbol)) return feedCache.get(symbol)!;
  const list: any[] = await (await fetch(`https://pyth.dourolabs.app/v1/symbols?query=${ticker}`)).json();
  const f = list.find((x) => x.symbol === symbol);
  if (!f) throw new Error(`no Pyth feed ${symbol}`);
  const m = f.market_session_schedule ?? {};
  const feed = { lazerId: f.pyth_lazer_id, symbol, schedule: { regular: m.regular ?? f.schedule, pre: m.pre_market ?? "", post: m.post_market ?? "", overnight: m.over_night ?? "" } };
  feedCache.set(symbol, feed);
  return feed;
}

export type Px = { price: number; conf: number; publishTime: number; source: string };

// Hermes feed id (hex) for the pull/push oracle; metadata is public even though prices need a key.
export async function hermesId(symbol: string): Promise<string | undefined> {
  const q = symbol.split(".").pop()!.split("/")[0];
  const list: any[] = await (await fetch(`https://hermes.pyth.network/v2/price_feeds?query=${encodeURIComponent(q)}`)).json();
  return list.find((x) => x.attributes?.symbol === symbol)?.id;
}

// PriceUpdateV2 account owned by the push oracle, shard 0.
export async function pushPrice(feedIdHex: string): Promise<Px | undefined> {
  const [pda] = await getProgramDerivedAddress({ programAddress: PUSH_ORACLE, seeds: [new Uint8Array([0, 0]), Buffer.from(feedIdHex, "hex")] });
  const a = await mainnet.getAccountInfo(pda, { encoding: "base64" }).send();
  if (!a.value) return;
  return decodePriceUpdate(Buffer.from(a.value.data[0], "base64"));
}

export function decodePriceUpdate(b: Buffer): Px {
  let o = 8 + 32; // discriminator + write_authority
  o += b[o] === 0 ? 2 : 1; // VerificationLevel::Partial{u8} | Full
  o += 32; // feed_id
  const price = b.readBigInt64LE(o), conf = b.readBigUInt64LE(o + 8), expo = b.readInt32LE(o + 16);
  return { price: Number(price) * 10 ** expo, conf: Number(conf) * 10 ** expo, publishTime: Number(b.readBigInt64LE(o + 20)) * 1000, source: "pyth-push" };
}

// ponytail: untested without a token; Pyth Pro REST per docs.pyth.network/price-feeds/pro. WS + onchain-verified payloads come later.
export async function proPrice(lazerId: number): Promise<Px | undefined> {
  const token = process.env.PYTH_PRO_TOKEN;
  if (!token) return;
  const r = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ priceFeedIds: [lazerId], properties: ["price", "confidence", "exponent", "feedUpdateTimestamp"], formats: [], channel: "fixed_rate@200ms", parsed: true }),
  });
  if (!r.ok) throw new Error(`pyth pro ${r.status}: ${await r.text()}`);
  const f = (await r.json()).parsed?.priceFeeds?.[0];
  if (!f?.price) return;
  const e = 10 ** Number(f.exponent);
  return { price: Number(f.price) * e, conf: Number(f.confidence ?? 0) * e, publishTime: Math.floor(Number(f.feedUpdateTimestamp) / 1000), source: "pyth-pro" };
}
