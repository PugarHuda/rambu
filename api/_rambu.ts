// Dependency-free Rambu plumbing for the Vercel functions: base58, PDA search, StockState decode,
// the check() mirror, a one-instruction legacy transaction for simulateTransaction, and JSON-RPC.
// Offsets mirror programs/rambu/src/lib.rs (and web/index.html decodeState).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PROGRAM = process.env.RAMBU_PROGRAM_ID ?? "5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm";
export const DEVNET = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
export const MAINNET = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
export const STATE_SIZE = 118;
export const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

// ---- base58 ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = "1" + s; }
  return s;
}
export function unb58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
export const pubkey = (s: string) => {
  const k = unb58(s);
  if (k.length !== 32) throw new Error(`not a 32-byte address: ${s}`);
  return k;
};
export const isAddress = (s: unknown): s is string => { try { return typeof s === "string" && pubkey(s).length === 32; } catch { return false; } };

// ---- hashing / PDA ----
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
export const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await crypto.subtle.digest("SHA-256", cat(...parts)));
export const disc = async (name: string) => (await sha256(utf8(`global:${name}`))).subarray(0, 8);
export const eventDisc = async (name: string) => (await sha256(utf8(`event:${name}`))).subarray(0, 8);

// ed25519 decompression test (same answer as curve25519-dalek's decompress().is_some(), which Solana uses)
const P = 2n ** 255n - 19n;
const pow = (b: bigint, e: bigint) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = (P - ((121665n * pow(121666n, P - 2n)) % P)) % P;
export function onCurve(k: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(k[i]);
  y = (y & ((1n << 255n) - 1n)) % P;
  const y2 = (y * y) % P;
  const x2 = (((y2 - 1n + P) % P) * pow((D * y2 + 1n) % P, P - 2n)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n; // x² must be a square mod p
}
export async function findPda(seeds: (string | Uint8Array)[], program: string): Promise<[string, number]> {
  const s = seeds.map((x) => (typeof x === "string" ? utf8(x) : x));
  const prog = pubkey(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256(...s, Uint8Array.of(bump), prog, utf8("ProgramDerivedAddress"));
    if (!onCurve(h)) return [b58(h), bump];
  }
  throw new Error("no PDA bump found");
}
export const statePda = async (mint: string) => (await findPda(["rambu", pubkey(mint)], PROGRAM))[0];
export const registryPda = async () => (await findPda(["registry"], PROGRAM))[0];

// ---- StockState ----
export const SESSION = ["unknown", "pre", "regular", "post", "overnight", "closed"];
export const HALT = ["none", "hard halt", "volatility pause", "issuer halt"];
export const EVENT = ["none", "merger", "tender offer", "delisting", "bankruptcy", "control change"];
const txt = (b: Uint8Array) => new TextDecoder().decode(b).replace(/[\0 ]+$/, "");

export type StockState = {
  key: string; mint: string; ticker: string; session: number; sessionName: string;
  halt: number; haltKind: string; haltCode: string; haltedAt: number; resumeAt: number;
  event: number; eventKind: string; eventRef: string;
  refPriceE6: number; refPrice: number; bandBps: number; maxAgeS: number; updatedAt: number; bump: number;
};
export function decodeState(bytes: Uint8Array, key: string): StockState {
  if (bytes.length !== STATE_SIZE) throw new Error(`StockState is ${STATE_SIZE} bytes, got ${bytes.length}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const i64 = (o: number) => Number(v.getBigInt64(o, true));
  const refPriceE6 = Number(v.getBigUint64(95, true));
  return {
    key, mint: b58(bytes.subarray(8, 40)), ticker: txt(bytes.subarray(40, 52)),
    session: bytes[52], sessionName: SESSION[bytes[52]] ?? "unknown",
    halt: bytes[53], haltKind: HALT[bytes[53]] ?? "unknown", haltCode: txt(bytes.subarray(54, 58)),
    haltedAt: i64(58), resumeAt: i64(66),
    event: bytes[74], eventKind: EVENT[bytes[74]] ?? "unknown", eventRef: txt(bytes.subarray(75, 95)),
    refPriceE6, refPrice: refPriceE6 / 1e6, bandBps: v.getUint16(103, true), maxAgeS: v.getUint32(105, true),
    updatedAt: i64(109), bump: bytes[117],
  };
}

// mirrors programs/rambu/src/lib.rs::check_with (same order, so the first failing rule names the error)
export const IGNORE_EVENTS = 1, REQUIRE_REGULAR_SESSION = 2;
export type Verdict = "Tradable" | "Stale" | "Halted" | "Paused" | "EventPending" | "SessionClosed" | "PriceRequired" | "NoReference" | "OutsideBand";
const tighter = (state: number, lender: number) => (lender === 0 ? state : Math.min(state, lender));
export function checkWith(s: StockState, now: number, priceE6: number, flags = 0, maxAgeS = 0, maxBandBps = 0): Verdict {
  const ignoreEvents = (flags & IGNORE_EVENTS) !== 0;
  if (now - s.updatedAt > tighter(s.maxAgeS, maxAgeS)) return "Stale";
  if (s.halt === 2) { if (!(s.resumeAt !== 0 && now >= s.resumeAt)) return "Paused"; }
  else if (s.halt !== 0) return "Halted";
  if (!ignoreEvents && s.event !== 0) return "EventPending";
  if ((flags & REQUIRE_REGULAR_SESSION) !== 0 && s.session !== 2) return "SessionClosed";
  if (priceE6 === 0) return ignoreEvents ? "Tradable" : "PriceRequired"; // only the swap path may skip the band
  if (s.refPriceE6 === 0) return "NoReference";
  if (Math.abs(priceE6 - s.refPriceE6) * 10_000 > s.refPriceE6 * tighter(s.bandBps, maxBandBps)) return "OutsideBand";
  return "Tradable";
}
export const check = (s: StockState, now: number, priceE6 = 0, ignoreEvents = false) => checkWith(s, now, priceE6, ignoreEvents ? IGNORE_EVENTS : 0);

// Anchor custom error codes of the rambu program (RambuError is append-only, 6000 + index).
export const ERR: Record<number, string> = {
  6000: "Stale", 6001: "Halted", 6002: "Paused", 6003: "EventPending", 6004: "OutsideBand", 6005: "BadParam",
  6006: "PriceRequired", 6007: "NoReference", 6008: "SessionClosed", 6009: "BadPayload", 6010: "FeedMismatch", 6011: "BadMint",
};
// Name a simulation error: known code, else Anchor's own "Error Code: X" log line, else the raw JSON.
export function errName(err: any, logs: string[] = []): string | null {
  if (!err) return null;
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom !== undefined && ERR[custom]) return ERR[custom];
  const m = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).find(Boolean);
  return m ?? (custom !== undefined ? `Custom(${custom})` : JSON.stringify(err));
}

// ---- transactions ----
export const u64le = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const le = (bits: 16 | 32, n: number) => { const b = new Uint8Array(bits / 8); const v = new DataView(b.buffer); bits === 16 ? v.setUint16(0, n, true) : v.setUint32(0, n, true); return b; };
// v1: accounts [state]
export async function assertTradableIx(priceE6: bigint, ignoreEvents = false): Promise<Uint8Array> {
  return cat(await disc("assert_tradable"), u64le(priceE6), Uint8Array.of(ignoreEvents ? 1 : 0));
}
// v2: accounts [state = PDA("rambu", mint)]; the caller can only tighten age/band (0 = state value)
export async function assertTradableV2Ix(mint: string, priceE6: bigint, flags = 0, maxAgeS = 0, maxBandBps = 0): Promise<Uint8Array> {
  return cat(await disc("assert_tradable_v2"), pubkey(mint), u64le(priceE6), Uint8Array.of(flags), le(32, maxAgeS), le(16, maxBandBps));
}
// get_price: accounts [state]; return data = ref_price_e6 u64 | expo i32 (-6) | updated_at i64
export const getPriceIx = async (mint: string) => cat(await disc("get_price"), pubkey(mint));
export function decodePrice(returnData: Uint8Array) {
  const v = new DataView(returnData.buffer, returnData.byteOffset, returnData.length);
  return { priceE6: Number(v.getBigUint64(0, true)), expo: v.getInt32(8, true), updatedAt: Number(v.getBigInt64(12, true)) };
}
// Simulate a one-ix tx on devnet with the keeper as fee payer (no signature needed); returns verdict + raw result.
export async function simulate(ix: Uint8Array, metas: Meta[]) {
  const payer = await keeperPubkey();
  const tx = legacyTx(payer, PROGRAM, metas, ix);
  const v = (await rpc(DEVNET, "simulateTransaction", [Buffer.from(tx).toString("base64"),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])).value;
  const logs: string[] = v.logs ?? [];
  return { verdict: errName(v.err, logs) ?? "Tradable", err: v.err, logs, unitsConsumed: v.unitsConsumed ?? 0, returnData: v.returnData?.data?.[0] ? b64(v.returnData.data[0]) : null, feePayer: payer };
}
const shortvec = (n: number) => { const out: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if (!n) { out.push(b); return Uint8Array.from(out); } out.push(b | 0x80); } };
export type Meta = { pubkey: string; signer: boolean; writable: boolean };
// Unsigned legacy transaction with one instruction; payer is the only signer. Signature slot is zeroed,
// fine for simulateTransaction with sigVerify:false and replaceRecentBlockhash:true.
export function legacyTx(payer: string, program: string, metas: Meta[], data: Uint8Array, blockhash = "11111111111111111111111111111111"): Uint8Array {
  const keys: Meta[] = [{ pubkey: payer, signer: true, writable: true }];
  for (const m of [...metas, { pubkey: program, signer: false, writable: false }]) {
    const k = keys.find((x) => x.pubkey === m.pubkey);
    if (k) { k.signer ||= m.signer; k.writable ||= m.writable; } else keys.push({ ...m });
  }
  const rank = (k: Meta) => (k.pubkey === payer ? -1 : (k.signer ? 0 : 2) + (k.writable ? 0 : 1));
  keys.sort((a, b) => rank(a) - rank(b));
  const idx = (p: string) => keys.findIndex((k) => k.pubkey === p);
  const signers = keys.filter((k) => k.signer).length;
  const header = Uint8Array.of(signers, keys.filter((k) => k.signer && !k.writable).length, keys.filter((k) => !k.signer && !k.writable).length);
  const msg = cat(
    header, shortvec(keys.length), ...keys.map((k) => pubkey(k.pubkey)), pubkey(blockhash),
    shortvec(1), Uint8Array.of(idx(program)), shortvec(metas.length), Uint8Array.from(metas.map((m) => idx(m.pubkey))),
    shortvec(data.length), data,
  );
  return cat(shortvec(signers), new Uint8Array(64 * signers), msg);
}

// ---- RPC ----
export async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    // ponytail: public RPCs rate-limit per method and send Retry-After (~10s on devnet), so honour it rather than
    // give up after 0.5/1/2/4s, which never outlasts that window. Capped at 12s so a retry still fits maxDuration 60.
    // Set DEVNET_RPC/MAINNET_RPC to a keyed endpoint to avoid the limit entirely.
    if ((r.status === 429 || /too many requests|rate limit/i.test(j.error?.message ?? "")) && attempt < 4) {
      const after = Number(r.headers.get("retry-after"));
      await new Promise((s) => setTimeout(s, Math.min(12_000, Number.isFinite(after) && after > 0 ? after * 1000 + 500 : 500 * 2 ** attempt)));
      continue;
    }
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
}
export const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

export async function clusterTime(): Promise<number> {
  const slot = await rpc(DEVNET, "getSlot", [{ commitment: "confirmed" }]);
  return (await rpc(DEVNET, "getBlockTime", [slot])) ?? Math.floor(Date.now() / 1000);
}
// ponytail: 10s in-instance memo; warm function instances share it, so bursts of Blink/API calls cost one getProgramAccounts
let memo: { at: number; p: Promise<StockState[]> } | undefined;
export function fetchStates(): Promise<StockState[]> {
  if (memo && Date.now() - memo.at < 10_000) return memo.p;
  const p = rpc(DEVNET, "getProgramAccounts", [PROGRAM, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: STATE_SIZE }] }])
    .then((res: any[]) => res.map((a) => decodeState(b64(a.account.data[0]), a.pubkey)).sort((a, b) => a.ticker.localeCompare(b.ticker)));
  memo = { at: Date.now(), p };
  p.catch(() => (memo = undefined));
  return p;
}
// No price given: judge the state as a lender would at the reference price (the program's get_price rules).
export const withVerdict = (s: StockState, now: number, priceE6 = 0) => ({ ...s, verdict: checkWith(s, now, priceE6 || s.refPriceE6), verdictPrice: (priceE6 || s.refPriceE6) / 1e6, ageS: now - s.updatedAt });

// Registry { authority: Pubkey, keeper: Pubkey, bump } -> keeper at 40..72
export async function keeperPubkey(): Promise<string> {
  const a = await rpc(DEVNET, "getAccountInfo", [await registryPda(), { encoding: "base64" }]);
  if (!a.value) throw new Error("rambu registry not initialized");
  return b58(b64(a.value.data[0]).subarray(40, 72));
}

// ---- web/data snapshots (bundled via vercel.json includeFiles) ----
export function readData(name: string): any | undefined {
  // cwd is the project root on Vercel; walking up also serves local runs started from keeper/ or qa/.
  // ponytail: no import.meta here — Vercel compiles these functions to CommonJS, where it is a syntax error.
  let dir = process.cwd();
  for (let up = 0; up < 4; up++, dir = dirname(dir)) {
    try { return JSON.parse(readFileSync(join(dir, "web/data", name), "utf8")); } catch {}
  }
}

// ---- HTTP ----
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids",
  "access-control-expose-headers": "X-Action-Version, X-Blockchain-Ids",
};
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers } });
export const cache = (s: number) => ({ "cache-control": `public, max-age=0, s-maxage=${s}, stale-while-revalidate=300` });
