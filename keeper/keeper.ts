// Polls halts / issuer status / SEC events and pushes changed Rambu states to Solana.
import { readFileSync } from "node:fs";
import { AccountRole, RAMBU, SYSTEM, address, disc, loadSigner, pda, pubkeyBytes, sendIx, statePda } from "./chain.ts";
import { fairPrice, type Fair } from "./fairprice.ts";
import { activeHalts, fetchEvents, fetchHalts, fetchXStocks, haltKind, sessionOf, Halt, type Event as Ev } from "./sources.ts";

const env = process.env;
const TRACK = (env.TRACK ?? "NVDA,AAPL,TSLA,SPY,QQQ,META,MSTR,COIN,HOOD,STRC,IWM").split(",");
const BAND_BPS = Number(env.BAND_BPS ?? 1000);
const MAX_AGE = Number(env.MAX_AGE_S ?? 900);
const INTERVAL = Number(env.INTERVAL_S ?? 60);
const flag = (f: string) => process.argv.indexOf(f);
const keeper = await loadSigner(env.KEEPER_KEYPAIR!);

type State = { ticker: string; session: number; halt: number; haltCode: string; haltedAt: number; resumeAt: number; event: Ev; eventRef: string; refPriceE6: bigint };

const bytes = (s: string, n: number) => { const b = new Uint8Array(n); b.set(new TextEncoder().encode(s).subarray(0, n)); return b; };

export function encodeUpsert(s: State): Uint8Array {
  const buf = Buffer.alloc(8 + 12 + 1 + 1 + 4 + 8 + 8 + 1 + 20 + 8 + 2 + 4);
  let o = 0;
  const put = (b: Uint8Array) => { buf.set(b, o); o += b.length; };
  put(disc("upsert")); put(bytes(s.ticker, 12));
  buf.writeUInt8(s.session, o++); buf.writeUInt8(s.halt, o++); put(bytes(s.haltCode, 4));
  buf.writeBigInt64LE(BigInt(Math.floor(s.haltedAt / 1000)), o); o += 8;
  buf.writeBigInt64LE(BigInt(Math.floor(s.resumeAt / 1000)), o); o += 8;
  buf.writeUInt8(s.event, o++); put(bytes(s.eventRef, 20));
  buf.writeBigUInt64LE(s.refPriceE6, o); o += 8;
  buf.writeUInt16LE(BAND_BPS, o); o += 2;
  buf.writeUInt32LE(MAX_AGE, o);
  return buf;
}

const upsert = async (mint: string, s: State) =>
  sendIx(keeper, RAMBU, encodeUpsert(s), [
    { address: await pda(RAMBU, "registry"), role: AccountRole.READONLY },
    { address: await statePda(address(mint)), role: AccountRole.WRITABLE },
    { address: address(mint), role: AccountRole.READONLY },
    { address: keeper.address, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
  ]);

if (flag("--init") >= 0) {
  const sig = await sendIx(keeper, RAMBU, Buffer.concat([disc("init_registry"), pubkeyBytes(keeper.address)]), [
    { address: await pda(RAMBU, "registry"), role: AccountRole.WRITABLE },
    { address: keeper.address, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
  ]);
  console.log("registry initialized", sig);
  process.exit(0);
}

// --replay file: { "NVDA": { "haltCode": "T1", "minutes": 10 } } replays a recorded halt onto a tracked stock for demos
const replay: Record<string, { haltCode: string; minutes: number }> =
  flag("--replay") >= 0 ? JSON.parse(readFileSync(process.argv[flag("--replay") + 1], "utf8")) : {};
const replayStart = Date.now();

// Reference = FairPrice per raw token (Pyth underlying × mint multiplier + unapplied dividend), what lenders value.
async function fair(x: { symbol: string; underlying: string; mint: string; issuerHalted: boolean; period: string }): Promise<Fair | undefined> {
  try { return await fairPrice(x); } catch (e: any) { console.error(x.symbol, "fairPrice failed:", e.message); }
}

const pushed = new Map<string, { key: string; at: number }>();
let events: Awaited<ReturnType<typeof fetchEvents>> = [];
let eventsAt = 0;

for (;;) {
  try {
    const [halts, xs] = await Promise.all([fetchHalts(), fetchXStocks()]);
    if (Date.now() - eventsAt > 10 * 60e3) { events = await fetchEvents(TRACK, 30); eventsAt = Date.now(); }
    const active = activeHalts(halts);
    const tracked = xs.filter((x) => TRACK.includes(x.underlying));

    for (const x of tracked) {
      const h = active.get(x.underlying);
      const r = replay[x.underlying] && Date.now() < replayStart + replay[x.underlying].minutes * 60e3 ? replay[x.underlying] : undefined;
      const ev = events.find((e) => e.ticker === x.underlying);
      const f = await fair(x);
      // fail closed: no fresh underlying price means no reference, so the stock is treated as halted
      const stale = !f || f.status === "Stale";
      const s: State = {
        ticker: x.symbol,
        session: sessionOf(x.period),
        halt: r ? haltKind(r.haltCode) : h ? haltKind(h.code) : x.issuerHalted || f?.status === "Halted" || stale ? Halt.Issuer : Halt.None,
        // "DIV" is informational: dividend ex but not in the multiplier yet; the fair reference already includes it
        haltCode: r?.haltCode ?? h?.code ?? (x.issuerHalted || f?.status === "Halted" ? "ISSR" : stale ? "STAL" : f?.status === "CorpActionPending" ? "DIV" : ""),
        haltedAt: r ? replayStart : h?.haltAt ?? 0,
        resumeAt: r ? replayStart + r.minutes * 60e3 : h?.resumeAt ?? 0,
        event: ev?.kind ?? 0,
        eventRef: ev?.accession ?? "",
        refPriceE6: BigInt(Math.round((f?.fairRaw ?? 0) * 1e6)),
      };
      // push on status change, or refresh before the onchain state goes stale
      // ref bucket: re-push when the fair price moves more than a quarter of the band
      const key = JSON.stringify({ t: s.ticker, se: s.session, h: s.halt, c: s.haltCode, e: s.event, r: s.eventRef, p: Math.round(Math.log(Number(s.refPriceE6) || 1) * 40_000 / BAND_BPS) });
      const last = pushed.get(x.mint);
      if (last && last.key === key && Date.now() - last.at < (MAX_AGE * 1000) / 2) continue;
      const sig = await upsert(x.mint, s);
      pushed.set(x.mint, { key, at: Date.now() });
      console.log(new Date().toISOString(), x.symbol.padEnd(7), `halt=${s.halt}:${s.haltCode || "-"} event=${s.event} session=${s.session} fair=${f?.fairRaw?.toFixed(2) ?? "-"} (${f?.px?.source ?? "no px"})`, sig);
    }
  } catch (e) {
    console.error(new Date().toISOString(), "tick failed:", e);
  }
  if (flag("--once") >= 0) process.exit(0);
  await new Promise((s) => setTimeout(s, INTERVAL * 1000));
}
