// Solana Action (Blink): "what did my SPYx/USDC Raydium CLMM position really earn?"
// GET  -> summary of the 30-day audit (web/data/sewa.json).
// POST {account} (or ?wallet= any wallet / position NFT) -> the wallet's positions in the audited pools:
//      snapshot fees / LVR / net / in-range %, plus live mainnet range status and uncollected fees (owedUsd)
//      computed from PersonalPositionState + PoolState + both TickArrays (Uniswap-v3 fee-growth-inside).
import { b58, b64, CORS, findPda, isAddress, MAINNET, pubkey, readData, rpc } from "../_rambu.ts";

const CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
const HEADERS = { ...CORS, "x-action-version": "2.4", "x-blockchain-ids": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...HEADERS } });
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const sgn = (x: number) => (x >= 0 ? "+" : "") + usd(x);

// ---- Raydium CLMM math (u128 wrapping, Q64.64 fee growth) ----
const U128 = 1n << 128n;
const u128 = (b: Uint8Array, o: number) => { let x = 0n; for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(b[o + i]); return x; };
const u64 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getBigUint64(o, true);
const i32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getInt32(o, true);
const wrap = (x: bigint) => ((x % U128) + U128) % U128;
export function feeGrowthInside(cur: number, lower: number, upper: number, global: bigint, outLower: bigint, outUpper: bigint): bigint {
  const below = cur >= lower ? outLower : wrap(global - outLower);
  const above = cur < upper ? outUpper : wrap(global - outUpper);
  return wrap(global - below - above);
}
export const owedDelta = (inside: bigint, last: bigint, liquidity: bigint) => (wrap(inside - last) * liquidity) >> 64n;
export const tickArrayStart = (tick: number, spacing: number) => Math.floor(tick / (60 * spacing)) * 60 * spacing;
const beI32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, false); return b; };

type Row = { nft: string; lower: number; upper: number; inRangePct: number; feesUsd: number; lvrUsd: number; owner?: string; owedUsd?: number };
// sewa.json pos rows: [nft, lower, upper, inRange%, fees, lvr, ...extra] or objects; owner/owedUsd when the audit adds them
const norm = (r: any): Row => Array.isArray(r)
  ? { nft: r[0], lower: r[1], upper: r[2], inRangePct: r[3], feesUsd: r[4], lvrUsd: r[5], owner: r.slice(6).find(isAddress), owedUsd: r.slice(6).find((x: unknown) => typeof x === "number") }
  : { nft: r.nft, lower: r.lower, upper: r.upper, inRangePct: r.inRangePct ?? r.inRange, feesUsd: r.feesUsd ?? r.fees, lvrUsd: r.lvrUsd ?? r.lvr, owner: r.owner, owedUsd: r.owedUsd };

const multi = async (keys: string[]): Promise<(Uint8Array | null)[]> => {
  const out: (Uint8Array | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc(MAINNET, "getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64" }]);
    out.push(...r.value.map((a: any) => (a ? b64(a.data[0]) : null)));
  }
  return out;
};

async function audit(who: string, sewa: any) {
  const pools = sewa.pools.map((p: any) => ({ ...p, rows: p.pos.map(norm) as Row[] }));
  const snap = new Map<string, [Row, any]>(pools.flatMap((p: any) => p.rows.map((r: Row) => [r.nft, [r, p]])));
  // candidate NFTs: owner field in the snapshot, NFTs the wallet holds now, or `who` itself if it is a position NFT
  const nfts = new Set<string>([who, ...[...snap.values()].filter(([r]) => r.owner === who).map(([r]) => r.nft)]);
  let walletNote = "";
  try {
    for (const prog of TOKEN_PROGRAMS) {
      const res = await rpc(MAINNET, "getTokenAccountsByOwner", [who, { programId: prog }, { encoding: "jsonParsed" }]);
      for (const a of res.value) { const i = a.account.data.parsed.info; if (i.tokenAmount.amount === "1" && i.tokenAmount.decimals === 0) nfts.add(i.mint); }
    }
  } catch (e: any) { walletNote = ` (wallet scan failed: ${e.message}; snapshot owner match only)`; }

  // live PersonalPositionState at PDA ["position", nft]: nft 9, pool 41, lower 73, upper 77, L 81, feeGrowthInsideLast0/1 97/113, owed0/1 129/137
  const list = [...nfts];
  const pdas = await Promise.all(list.map(async (m) => (await findPda(["position", pubkey(m)], CLMM))[0]));
  const accts = await multi(pdas);
  const ids = new Set(pools.map((p: any) => p.pool.id));
  const live = accts.map((b, i) => b && b.length === 281 && ids.has(b58(b.subarray(41, 73)))
    ? { nft: list[i], pool: b58(b.subarray(41, 73)), lower: i32(b, 73), upper: i32(b, 77), L: u128(b, 81), last0: u128(b, 97), last1: u128(b, 113), owed0: u64(b, 129), owed1: u64(b, 137) }
    : null).filter((x) => x !== null);
  if (!live.length) {
    // closed since the snapshot, or NFT held elsewhere: report snapshot rows that still name this owner
    const old = [...snap.values()].filter(([r]) => r.owner === who || r.nft === who);
    return { lines: old.map(([r, p]) => line(r, p, null)), n: old.length, walletNote };
  }

  // PoolState: tickSpacing 235, sqrtPrice 253, tick 269, feeGrowthGlobal0/1 277/293
  const poolIds = [...new Set(live.map((x) => x.pool))];
  const poolBytes = new Map(poolIds.map((id, i) => [id, null as Uint8Array | null]));
  (await multi(poolIds)).forEach((b, i) => poolBytes.set(poolIds[i], b));
  const taKey = async (pool: string, start: number) => (await findPda(["tick_array", pubkey(pool), beI32(start)], CLMM))[0];
  const need = new Map<string, null | Uint8Array>();
  const plan = await Promise.all(live.map(async (x) => {
    const sp = new DataView(poolBytes.get(x.pool)!.buffer, poolBytes.get(x.pool)!.byteOffset).getUint16(235, true);
    const lo = await taKey(x.pool, tickArrayStart(x.lower, sp)), hi = await taKey(x.pool, tickArrayStart(x.upper, sp));
    need.set(lo, null); need.set(hi, null);
    return { sp, lo, hi };
  }));
  const taKeys = [...need.keys()];
  (await multi(taKeys)).forEach((b, i) => need.set(taKeys[i], b));
  // TickArrayState (packed): start 40, ticks[60] from 44, 168 bytes each; fee_growth_outside_0/1 at +36/+52
  const outside = (ta: Uint8Array, tick: number, sp: number) => {
    const o = 44 + ((tick - i32(ta, 40)) / sp) * 168;
    if (i32(ta, o) !== tick) throw new Error(`tick ${tick} not initialized in its tick array`);
    return [u128(ta, o + 36), u128(ta, o + 52)];
  };

  const lines: string[] = [];
  live.forEach((x, k) => {
    const pb = poolBytes.get(x.pool)!, p = pools.find((q: any) => q.pool.id === x.pool);
    const cur = i32(pb, 269), sqrt = Number(u128(pb, 253)) / 2 ** 64;
    const px0 = sqrt * sqrt * 10 ** (p.pool.dec0 - p.pool.dec1); // USDC per SPYx
    let owedUsd: number | undefined, owedTxt = "";
    try {
      const { sp, lo, hi } = plan[k];
      const [ol0, ol1] = outside(need.get(lo)!, x.lower, sp), [ou0, ou1] = outside(need.get(hi)!, x.upper, sp);
      const o0 = x.owed0 + owedDelta(feeGrowthInside(cur, x.lower, x.upper, u128(pb, 277), ol0, ou0), x.last0, x.L);
      const o1 = x.owed1 + owedDelta(feeGrowthInside(cur, x.lower, x.upper, u128(pb, 293), ol1, ou1), x.last1, x.L);
      const a0 = Number(o0) / 10 ** p.pool.dec0, a1 = Number(o1) / 10 ** p.pool.dec1;
      owedUsd = a0 * px0 + a1; // ponytail: USDC valued at $1
      owedTxt = `${a0.toFixed(4)} SPYx + ${a1.toFixed(2)} USDC`;
    } catch (e: any) { owedTxt = `owed unavailable: ${e.message}`; }
    const r = snap.get(x.nft)?.[0];
    const now = cur >= x.lower && cur < x.upper ? "in range now" : "out of range now";
    lines.push(line(r ?? { nft: x.nft, lower: x.lower, upper: x.upper } as Row, p, { now, owedUsd, owedTxt, fresh: !r }));
  });
  return { lines, n: live.length, walletNote };
}

const tickPx = (t: number, p: any) => 1.0001 ** t * 10 ** (p.pool.dec0 - p.pool.dec1);
function line(r: Row, p: any, live: { now: string; owedUsd?: number; owedTxt: string; fresh: boolean } | null) {
  const head = `${r.nft.slice(0, 6)}…${r.nft.slice(-4)} · pool ${p.pool.id.slice(0, 6)} (${p.pool.feeRate * 1e4}bp) · range ${usd(tickPx(r.lower, p))}–${usd(tickPx(r.upper, p))}`;
  const owed = live?.owedUsd ?? r.owedUsd;
  const tail = owed !== undefined ? ` · owedUsd ${usd(owed)}${live?.owedTxt ? ` (${live.owedTxt})` : ""}` : live?.owedTxt ? ` · ${live.owedTxt}` : "";
  if (live?.fresh) return `${head} · ${live.now} · opened after the ${new Date(p.to).toISOString().slice(0, 10)} audit snapshot, so no fee/LVR replay for it${tail}`;
  return `${head} · in range ${r.inRangePct}% · fees ${usd(r.feesUsd)} · LVR ${usd(r.lvrUsd)} · net ${sgn(r.feesUsd - r.lvrUsd)}${live ? ` · ${live.now}` : " · position closed or moved"}${tail}`;
}

function get(req: Request, sewa: any) {
  const icon = new URL("/icon.svg", req.url).toString();
  const pools = sewa.pools.map((p: any) => {
    const t = Object.values(p.bySession).reduce((a: any, b: any) => ({ f: a.f + b.feesUsd, l: a.l + b.lvrUsd }), { f: 0, l: 0 }) as any;
    return `${p.pool.id.slice(0, 6)} (${p.pool.feeRate * 1e4}bp, ${p.positions} positions): fees ${usd(t.f)}, LVR ${usd(t.l)}, net ${sgn(t.f - t.l)}`;
  });
  return reply({
    type: "action", icon, label: "Audit my positions",
    title: `Rambu LP audit: ${sewa.xsymbol}/USDC on Raydium CLMM`,
    description: `${sewa.days}-day replay to ${new Date(sewa.at).toISOString().slice(0, 16)}Z of fees minus LVR (loss-versus-rebalancing against an external fair price), split by market session. ${pools.join(". ")}.`,
    links: { actions: [
      { type: "post", label: "Audit my positions", href: "/api/actions/lp" },
      { type: "post", label: "Audit", href: "/api/actions/lp?wallet={wallet}", parameters: [{ type: "text", name: "wallet", label: "Any wallet or position NFT", required: true }] },
    ] },
  });
}

async function post(req: Request, sewa: any) {
  const body: any = await req.json().catch(() => ({}));
  const who = new URL(req.url).searchParams.get("wallet") || body.account;
  if (!isAddress(who)) return reply({ message: "account / wallet must be a Solana address" }, 400);
  const { lines, n, walletNote } = await audit(who, sewa);
  const title = n ? `${n} ${sewa.xsymbol}/USDC position${n > 1 ? "s" : ""} for ${who.slice(0, 4)}…${who.slice(-4)}` : `No ${sewa.xsymbol}/USDC positions for ${who.slice(0, 4)}…${who.slice(-4)}`;
  const description = (lines.join("\n") || `No position NFT for the audited pools (${sewa.pools.map((p: any) => p.pool.id.slice(0, 6)).join(", ")}) is held by this address.`) + walletNote;
  return reply({
    type: "post", message: title,
    links: { next: { type: "inline", action: { type: "completed", icon: new URL("/icon.svg", req.url).toString(), title, description, label: n ? "Audited" : "Nothing to audit" } } },
    positions: lines,
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
      const sewa = readData("sewa.json");
      if (!sewa) return reply({ message: "sewa.json snapshot missing from the deployment" }, 500);
      if (req.method === "GET") return get(req, sewa);
      if (req.method === "POST") return await post(req, sewa);
      return reply({ message: "method not allowed" }, 405);
    } catch (e: any) {
      return reply({ message: e.message }, 502);
    }
  },
};
