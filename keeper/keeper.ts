// Polls halts / issuer status / SEC events and pushes changed Rambu states to Solana.
// node keeper.ts [--once] [--check] [--replay fixtures/replay.json]. Registry admin lives in admin.ts.
import { readFileSync } from "node:fs";
import { AccountRole, RAMBU, SYSTEM, address, disc, getAddressDecoder, loadSigner, pda, pushReasons, readStates, rpc, sendIx, statePda, type OnchainState } from "./chain.ts";
import { fairPrice, type Fair } from "./fairprice.ts";
import { activeHalts, fetchEvents, fetchHalts, fetchXStocks, haltKind, sessionOf, Halt, type Event as Ev, type ExchangeHalt } from "./sources.ts";

const env = process.env;
const TRACK = (env.TRACK ?? "NVDA,AAPL,TSLA,SPY,QQQ,META,MSTR,COIN,HOOD,STRC,IWM").split(",");
const BAND_BPS = Number(env.BAND_BPS ?? 1000);
const MAX_AGE = Number(env.MAX_AGE_S ?? 900);
const INTERVAL = Number(env.INTERVAL_S ?? 60);
const MIN_SOL = 0.05;
const flag = (f: string) => process.argv.indexOf(f);
// --check runs without a key (snapshot job): it reads the keeper pubkey from the registry instead
const keeper = flag("--check") >= 0 && !env.KEEPER_KEYPAIR ? undefined! : await loadSigner(env.KEEPER_KEYPAIR!);

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

// Alerts go to Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set; otherwise the log line is the alert.
async function notify(msg: string) {
  console.log(new Date().toISOString(), "ALERT", msg);
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = env;
  if (!tok || !chat) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `rambu keeper: ${msg}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10e3),
    });
    if (!r.ok) console.error("telegram: HTTP", r.status, (await r.text()).slice(0, 200));
  } catch (e: any) { console.error("telegram:", e.message); }
}

const tracked = async () => (await fetchXStocks()).filter((x) => TRACK.includes(x.underlying));
const nowS = () => Math.floor(Date.now() / 1000);

// --check: exit 1 when a tracked state is past its max_age (assert_tradable already says Stale) or the keeper runs dry
if (flag("--check") >= 0) {
  const xs = await tracked();
  const states = await readStates(xs.map((x) => address(x.mint)));
  // Registry = disc 8 | authority 32 | keeper 32 | bump
  const reg = (await rpc.getAccountInfo(await pda(RAMBU, "registry"), { encoding: "base64" }).send()).value;
  if (!reg) throw new Error("registry not initialized");
  const regKeeper = getAddressDecoder().decode(Buffer.from(reg.data[0], "base64").subarray(40, 72));
  const lamports = Number((await rpc.getBalance(regKeeper).send()).value);
  const bad: string[] = [];
  xs.forEach((x, i) => {
    const s = states[i], age = s ? nowS() - s.updatedAt : Infinity;
    console.log(x.symbol.padEnd(7), s ? `age=${age}s max_age=${s.maxAgeS}s halt=${s.halt}:${s.haltCode || "-"} event=${s.event} ref=${(Number(s.refPriceE6) / 1e6).toFixed(2)}` : "no state");
    if (!s || age > s.maxAgeS) bad.push(`${x.symbol} ${s ? `stale ${age}s` : "missing"}`);
  });
  for (const t of TRACK) if (!xs.some((x) => x.underlying === t)) console.warn(`${t}: not an xStock on Solana, skipped`);
  console.log(`keeper ${regKeeper} balance ${(lamports / 1e9).toFixed(4)} SOL`);
  if (keeper && keeper.address !== regKeeper) bad.push(`KEEPER_KEYPAIR ${keeper.address} is not the registry keeper ${regKeeper}`);
  if (lamports < MIN_SOL * 1e9) bad.push(`balance ${(lamports / 1e9).toFixed(4)} SOL < ${MIN_SOL}`);
  if (bad.length) await notify(`check failed (${env.RPC_URL ?? "devnet"}): ${bad.join(", ")}`);
  process.exit(bad.length ? 1 : 0);
}

// --replay file: { "NVDA": { "haltCode": "T1", "minutes": 10 } } replays a recorded halt onto a tracked stock for demos
const replay: Record<string, { haltCode: string; minutes: number }> =
  flag("--replay") >= 0 ? JSON.parse(readFileSync(process.argv[flag("--replay") + 1], "utf8")) : {};
const replayStart = Date.now();

// Reference = FairPrice per raw token (Pyth underlying × mint multiplier + unapplied dividend), what lenders value.
async function fair(x: { symbol: string; underlying: string; mint: string; issuerHalted: boolean; period: string }): Promise<Fair | undefined> {
  try { return await fairPrice(x); } catch (e: any) { console.error(x.symbol, "fairPrice failed:", e.message); }
}

// Last good source reads. Halts are trusted for MAX_AGE/2, then pushes stop so the onchain state goes Stale (fail closed).
let halts: ExchangeHalt[] = [], haltsAt = 0, haltsDown = false;
let events: Awaited<ReturnType<typeof fetchEvents>> | undefined, eventsAt = 0;

async function tick(): Promise<number> {
  let failed = 0;
  try { halts = await fetchHalts(); haltsAt = Date.now(); } catch (e: any) { failed++; console.error("halts feed failed:", e.message); }
  const haltsAge = (Date.now() - haltsAt) / 1000;
  if (haltsAge > MAX_AGE / 2) {
    if (!haltsDown) await notify(`halts feed unavailable for ${haltsAt ? `${Math.round(haltsAge)}s` : "the whole run"}; pushes paused, states will go Stale`);
    haltsDown = true;
    return failed || 1;
  }
  if (haltsDown) await notify("halts feed back, pushes resumed");
  haltsDown = false;

  if (Date.now() - eventsAt > 10 * 60e3) {
    try { events = await fetchEvents(TRACK, 30); eventsAt = Date.now(); }
    catch (e: any) { failed++; console.error("SEC events failed, keeping", events ? "last read" : "onchain events", e.message); }
  }
  const active = activeHalts(halts);
  const xs = await tracked();
  const chain = await readStates(xs.map((x) => address(x.mint)));
  let sent = 0;

  for (const [i, x] of xs.entries()) {
    try {
      const prev: OnchainState | undefined = chain[i];
      const h = active.get(x.underlying);
      const r = replay[x.underlying] && Date.now() < replayStart + replay[x.underlying].minutes * 60e3 ? replay[x.underlying] : undefined;
      // SEC never read in this process: carry the onchain event instead of clearing it
      const ev = events ? events.find((e) => e.ticker === x.underlying) : prev && { kind: prev.event as Ev, accession: prev.eventRef };
      const f = await fair(x);
      // fail closed: no fresh underlying price means no reference, so the stock is treated as halted
      const stale = !f || f.status === "Stale";
      const halted = x.issuerHalted || f?.status === "Halted";
      const s: State = {
        ticker: x.symbol,
        session: sessionOf(x.period),
        halt: r ? haltKind(r.haltCode) : h ? haltKind(h.code) : halted || stale ? Halt.Issuer : Halt.None,
        // "DIV" is informational: dividend ex but not in the multiplier yet; the fair reference already includes it
        haltCode: r?.haltCode ?? h?.code ?? (halted ? "ISSR" : stale ? "STAL" : f?.status === "CorpActionPending" ? "DIV" : ""),
        haltedAt: r ? replayStart : h?.haltAt ?? 0,
        resumeAt: r ? replayStart + r.minutes * 60e3 : h?.resumeAt ?? 0,
        event: ev?.kind ?? 0,
        eventRef: ev?.accession ?? "",
        refPriceE6: BigInt(Math.round((f?.fairRaw ?? 0) * 1e6)),
      };
      // a pause with no resumption time yet blocks like a hard halt (and upsert rejects Soft with resume_at 0)
      if (s.halt === Halt.Soft && !s.resumeAt) s.halt = Halt.Hard;
      const why = pushReasons(prev, { ...s, haltedAtS: Math.floor(s.haltedAt / 1000), resumeAtS: Math.floor(s.resumeAt / 1000) }, { bandBps: BAND_BPS, maxAgeS: MAX_AGE }, nowS());
      const line = `${x.symbol.padEnd(7)} halt=${s.halt}:${s.haltCode || "-"} event=${s.event} session=${s.session} fair=${f?.fairRaw?.toFixed(2) ?? "-"} (${f?.px?.source ?? "no px"})`;
      if (prev && why.some((w) => ["missed", "halt", "event", "ref"].includes(w))) {
        const was = `halt=${prev.halt}:${prev.haltCode || "-"} event=${prev.event} ref=${(Number(prev.refPriceE6) / 1e6).toFixed(2)}`;
        await notify(`${line} [${why.join(",")}] was ${was}${why.includes("missed") ? `, onchain was ${nowS() - prev.updatedAt}s old` : ""}`);
      }
      if (!why.length) { console.log(new Date().toISOString(), line, "fresh, skip"); continue; }
      const sig = await upsert(x.mint, s);
      sent++;
      console.log(new Date().toISOString(), line, `[${why.join(",")}]`, sig);
    } catch (e: any) {
      failed++;
      console.error(new Date().toISOString(), x.symbol, "failed:", e.message ?? e);
    }
  }
  console.log(new Date().toISOString(), `tick: ${xs.length} stocks, ${sent} tx, ${failed} failed`);
  return failed;
}

for (;;) {
  let failed: number;
  try { failed = await tick(); } catch (e: any) { failed = 1; console.error(new Date().toISOString(), "tick failed:", e.message ?? e); }
  if (flag("--once") >= 0) process.exit(failed ? 1 : 0);
  await new Promise((s) => setTimeout(s, INTERVAL * 1000));
}
