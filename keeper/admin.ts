// Registry admin + devnet plumbing for the verified (Pyth Pro) path. Signs with ADMIN_KEYPAIR (default keys/deployer.json);
// never prints key material.
// usage:
//   node --env-file=.env admin.ts --init                    create the registry (upgrade authority only), keeper = signer
//   node --env-file=.env admin.ts --set-keeper <pubkey>
//   node --env-file=.env admin.ts --set-authority <pubkey>
//   node --env-file=.env admin.ts --mirror QQQx             devnet Token-2022 mirror of the mainnet mint (same multiplier) + feed links
import { createHash } from "node:crypto";
import {
  appendTransactionMessageInstructions, createAddressWithSeed, createTransactionMessage, getAddressDecoder, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, pipe, sendAndConfirmTransactionFactory, createSolanaRpcSubscriptions,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type KeyPairSigner,
} from "@solana/kit";
import { AccountRole, RAMBU, RPC, SYSTEM, address, disc, loadSigner, logsOf, pda, pubkeyBytes, rpc, statePda, type Meta } from "./chain.ts";
import { fairPrice, multiplierAt, readMint, type Fair } from "./fairprice.ts";
import { feedOf } from "./pyth.ts";
import { fetchXStocks } from "./sources.ts";

export const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ED25519 = address("Ed25519SigVerify111111111111111111111111111");
export const PYTH_LAZER = address("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
export const PYTH_STORAGE = address("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
export const IX_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const SESSION = { pre: 1, regular: 2, post: 3, overnight: 4, closed: 5 } as const;
export const IGNORE_EVENTS = 1, REQUIRE_REGULAR_SESSION = 2;

export const admin = () => loadSigner(process.env.ADMIN_KEYPAIR ?? process.env.KEEPER_KEYPAIR ?? "../keys/deployer.json");
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(process.env.WS_URL ?? RPC.replace(/^http/, "ws")) });

// public devnet RPC rate-limits bursts (HTTP 429): back off and retry
export async function retry<T>(f: () => Promise<T>, n = 10): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e: any) {
      if (i >= n || !/429/.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1500 * 2 ** i, 20_000)));
    }
  }
}

export type Ix = { programAddress: Address; data: Uint8Array; accounts: Meta[] };
// Several instructions, one transaction (Ed25519 verify + the ix that reads it must share a tx).
// Signed once; a 429 retry resends the same tx (same signature) unless it already landed, so nothing runs twice.
export async function sendIxs(payer: KeyPairSigner, ixs: Ix[]) {
  const tx = await retry(() => build(payer, ixs));
  const sig = getSignatureFromTransaction(tx);
  await retry(async () => {
    const st: any = await rpc.getSignatureStatuses([sig]).send().catch(() => undefined);
    const s = st?.value?.[0];
    if (s?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
    try { await send(tx as any, { commitment: "confirmed" }); } catch (e: any) {
      if (!/already been processed/.test(errName(e))) throw e; // our earlier send landed while its confirmation hit a 429
    }
  });
  return sig;
}

// Same transaction, simulated: logs + return data without spending getTransaction quota (10/10s on public devnet).
export const simulateIxs = (payer: KeyPairSigner, ixs: Ix[]) => retry(async () => {
  const r: any = await rpc.simulateTransaction(getBase64EncodedWireTransaction(await build(payer, ixs)), { encoding: "base64", commitment: "confirmed" }).send();
  return { err: r.value.err, logs: (r.value.logs ?? []) as string[], returnData: r.value.returnData?.data?.[0] ? Buffer.from(r.value.returnData.data[0], "base64") : undefined, units: r.value.unitsConsumed };
});

async function build(payer: KeyPairSigner, ixs: Ix[]) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  return signTransactionMessageWithSigners(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs.map((i) => ({
      programAddress: i.programAddress, data: i.data,
      accounts: i.accounts.map((a) => (a.signer ? { address: a.address, role: a.role, signer: a.signer } : { address: a.address, role: a.role })),
    })) as any, m),
  ));
}

// "Error Code: X" from Anchor logs, else the RPC message
export const errName = (e: any) =>
  logsOf(e).join("\n").match(/Error Code: (\w+)/)?.[1] ?? [e?.message ?? String(e), e?.cause?.message].filter(Boolean).join(": ");

export async function account(a: Address): Promise<Buffer | undefined> {
  const r: any = await retry(() => rpc.getAccountInfo(a, { encoding: "base64" }).send());
  return r.value ? Buffer.from(r.value.data[0], "base64") : undefined;
}

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const f64 = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const fixed = (s: string, n: number) => { const b = Buffer.alloc(n); b.write(s.slice(0, n)); return b; };
export const eventDisc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

// ---- registry ----

export const registryPda = () => pda(RAMBU, "registry");
export const feedPda = (mint: Address) => pda(RAMBU, "feed", pubkeyBytes(mint));

export async function readRegistry() {
  const d = await account(await registryPda());
  if (!d) return;
  const dec = getAddressDecoder();
  return { authority: dec.decode(d.subarray(8, 40)), keeper: dec.decode(d.subarray(40, 72)) };
}

async function init(signer: KeyPairSigner) {
  const reg = await readRegistry();
  if (reg) return console.log(`registry already initialized: authority ${reg.authority}, keeper ${reg.keeper}`);
  const programData = await pda(LOADER, pubkeyBytes(RAMBU));
  const sig = await sendIxs(signer, [{ programAddress: RAMBU, data: Buffer.concat([disc("init_registry"), pubkeyBytes(signer.address)]), accounts: [
    { address: await registryPda(), role: AccountRole.WRITABLE },
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
    { address: RAMBU, role: AccountRole.READONLY },
    { address: programData, role: AccountRole.READONLY },
  ] }]);
  console.log("registry initialized", sig);
}

const setAdmin = async (signer: KeyPairSigner, ix: "set_keeper" | "set_authority", to: Address) =>
  sendIxs(signer, [{ programAddress: RAMBU, data: Buffer.concat([disc(ix), pubkeyBytes(to)]), accounts: [
    { address: await registryPda(), role: AccountRole.WRITABLE },
    { address: signer.address, role: AccountRole.READONLY_SIGNER },
  ] }]);

export const setFeed = async (signer: KeyPairSigner, mint: Address, feedId: number) =>
  sendIxs(signer, [{ programAddress: RAMBU, data: Buffer.concat([disc("set_feed"), pubkeyBytes(mint), u32(feedId)]), accounts: [
    { address: await registryPda(), role: AccountRole.READONLY },
    { address: await feedPda(mint), role: AccountRole.WRITABLE },
    { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
  ] }]);

// ---- state (same Borsh layout as keeper.ts encodeUpsert) ----

export type Upsert = { ticker: string; session: number; halt: number; haltCode?: string; resumeAt?: number; event?: number; eventRef?: string; refPriceE6: bigint; bandBps: number; maxAgeS: number };

export const upsertIx = async (keeper: KeyPairSigner, mint: Address, s: Upsert): Promise<Ix> => ({
  programAddress: RAMBU,
  data: Buffer.concat([disc("upsert"), fixed(s.ticker, 12), Buffer.from([s.session, s.halt]), fixed(s.haltCode ?? "", 4),
    i64(0n), i64(BigInt(s.resumeAt ?? 0)), Buffer.from([s.event ?? 0]), fixed(s.eventRef ?? "", 20), u64(s.refPriceE6), u16(s.bandBps), u32(s.maxAgeS)]),
  accounts: [
    { address: await registryPda(), role: AccountRole.READONLY },
    { address: await statePda(mint), role: AccountRole.WRITABLE },
    { address: mint, role: AccountRole.READONLY },
    { address: keeper.address, role: AccountRole.WRITABLE_SIGNER, signer: keeper },
    { address: SYSTEM, role: AccountRole.READONLY },
  ],
});

export async function readState(mint: Address) {
  const d = await account(await statePda(mint));
  if (!d || d.length !== 118) return;
  let o = 40;
  const ticker = d.subarray(o, o + 12).toString().replace(/\0+$/, ""); o += 12;
  const session = d[o++], halt = d[o++];
  const haltCode = d.subarray(o, o + 4).toString().replace(/\0+$/, ""); o += 4 + 16;
  const event = d[o++]; o += 20;
  const refPriceE6 = d.readBigUInt64LE(o); o += 8;
  const bandBps = d.readUInt16LE(o); o += 2;
  const maxAgeS = d.readUInt32LE(o); o += 4;
  return { ticker, session, halt, haltCode, event, refPriceE6, bandBps, maxAgeS, updatedAt: Number(d.readBigInt64LE(o)) };
}

// Live state from FairPrice, same rules as keeper.ts (fail closed on stale or issuer halt).
export const liveState = (ticker: string, f: Fair): Upsert => ({
  ticker, session: SESSION[f.session] ?? 0,
  halt: f.status === "Halted" || f.status === "Stale" ? 3 : 0,
  haltCode: f.status === "Halted" ? "ISSR" : f.status === "Stale" ? "STAL" : f.status === "CorpActionPending" ? "DIV" : "",
  refPriceE6: BigInt(Math.round((f.fairRaw ?? 0) * 1e6)), bandBps: Number(process.env.BAND_BPS ?? 1000), maxAgeS: Number(process.env.MAX_AGE_S ?? 900),
});

// ---- devnet mirror of a mainnet xStock mint ----
// xStocks mints only exist on mainnet. The verified path reads the multiplier from the mint account, so devnet gets a
// Token-2022 mint with the same ScaledUiAmount multiplier, at a deterministic address (deployer + seed).
// ponytail: mirror multiplier is synced when --mirror / verify-chain runs, not on every mainnet step

const MINT_SPACE = 166 + 4 + 56; // base mint padded to 165, account type, ScaledUiAmount TLV

export const mirrorAddress = (base: Address, symbol: string) => createAddressWithSeed({ baseAddress: base, programAddress: TOKEN_2022, seed: `rambu-${symbol}` });

export function mirrorMultiplier(d: Buffer, now = Date.now() / 1000) {
  for (let o = 166; o + 4 <= d.length; o += 4 + d.readUInt16LE(o + 2)) {
    if (d.readUInt16LE(o) !== 25) continue;
    const v = d.subarray(o + 4);
    return now >= Number(v.readBigInt64LE(40)) ? v.readDoubleLE(48) : v.readDoubleLE(32);
  }
  return 1;
}

export async function mirror(signer: KeyPairSigner, symbol: string) {
  const x = (await fetchXStocks()).find((s) => s.symbol === symbol);
  if (!x) throw new Error(`unknown xStock ${symbol}`);
  const now = Date.now();
  const m = multiplierAt(await readMint(x.mint), now);
  const feedId = (await feedOf(x.underlying)).lazerId;
  const mint = await mirrorAddress(signer.address, symbol);
  const d = await account(mint);
  if (!d) {
    const lamports = await retry(() => rpc.getMinimumBalanceForRentExemption(BigInt(MINT_SPACE)).send());
    const seed = Buffer.from(`rambu-${symbol}`);
    const sig = await sendIxs(signer, [
      // system CreateAccountWithSeed
      { programAddress: SYSTEM, data: Buffer.concat([u32(3), pubkeyBytes(signer.address), u64(BigInt(seed.length)), seed, u64(lamports), u64(BigInt(MINT_SPACE)), pubkeyBytes(TOKEN_2022)]), accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: mint, role: AccountRole.WRITABLE },
        { address: signer.address, role: AccountRole.READONLY_SIGNER },
      ] },
      // ScaledUiAmountExtension::Initialize { authority, multiplier }
      { programAddress: TOKEN_2022, data: Buffer.concat([Buffer.from([43, 0]), pubkeyBytes(signer.address), f64(m)]), accounts: [{ address: mint, role: AccountRole.WRITABLE }] },
      // InitializeMint2 { decimals 8, mint authority, no freeze }
      { programAddress: TOKEN_2022, data: Buffer.concat([Buffer.from([20, 8]), pubkeyBytes(signer.address), Buffer.from([0])]), accounts: [{ address: mint, role: AccountRole.WRITABLE }] },
    ]);
    console.log(`${symbol} devnet mirror mint ${mint} created, multiplier ${m}`, sig);
  } else if (Math.abs(mirrorMultiplier(d) - m) > 1e-12) {
    // ScaledUiAmountExtension::UpdateMultiplier { multiplier, effective_timestamp = now }
    const sig = await sendIxs(signer, [{ programAddress: TOKEN_2022, data: Buffer.concat([Buffer.from([43, 1]), f64(m), i64(BigInt(Math.floor(now / 1000)))]), accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: signer.address, role: AccountRole.READONLY_SIGNER },
    ] }]);
    console.log(`${symbol} mirror multiplier ${mirrorMultiplier(d)} -> ${m}`, sig);
  }
  // link both the mainnet mint and its devnet mirror to the Pyth Pro feed
  for (const a of [mint, address(x.mint)]) {
    const f = await account(await feedPda(a));
    if (!f || f.readUInt32LE(40) !== feedId) console.log(`feed link ${a} -> ${feedId}`, await setFeed(signer, a, feedId));
  }
  return { mint, real: address(x.mint), multiplier: m, feedId, x };
}

export async function liveMirrorState(symbol: string, x: Awaited<ReturnType<typeof mirror>>["x"]) {
  return liveState(`${symbol}-dev`, await fairPrice(x));
}

// ---- Pyth Pro signed payloads ----

export async function lazerMessage(feedId: number): Promise<Buffer> {
  const r = await fetch("https://pyth-lazer.dourolabs.app/v1/latest_price", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.PYTH_PRO_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ priceFeedIds: [feedId], properties: ["price", "exponent", "confidence", "marketSession", "feedUpdateTimestamp"], formats: ["solana"], channel: "fixed_rate@200ms", jsonBinaryEncoding: "hex" }),
  });
  if (!r.ok) throw new Error(`pyth pro ${r.status}: ${await r.text()}`);
  return Buffer.from((await r.json()).solana.data, "hex");
}

// Ed25519 precompile ix pointing into the message that sits at offset 12 (disc 8 + vec len 4) of ix `targetIndex`.
export function ed25519Ix(message: Buffer, targetIndex: number): Ix {
  const sig = 12 + 4, pk = sig + 64, msg = pk + 32 + 2;
  return { programAddress: ED25519, accounts: [], data: Buffer.concat([Buffer.from([1, 0]),
    u16(sig), u16(targetIndex), u16(pk), u16(targetIndex), u16(msg), u16(message.readUInt16LE(100)), u16(targetIndex)]) };
}

export const vecU8 = (b: Buffer) => Buffer.concat([u32(b.length), b]);
export const argBytes = { u16, u32, u64 };

export async function pythAccounts() {
  const s = await account(PYTH_STORAGE);
  if (!s) throw new Error("Pyth Lazer storage missing on this cluster");
  return { treasury: getAddressDecoder().decode(s.subarray(40, 72)) };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const val = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const signer = await admin();
  try {
    if (argv.includes("--init")) await init(signer);
    if (val("--set-keeper")) console.log("keeper set", await setAdmin(signer, "set_keeper", address(val("--set-keeper")!)));
    if (val("--set-authority")) console.log("authority set", await setAdmin(signer, "set_authority", address(val("--set-authority")!)));
    if (val("--mirror")) {
      const r = await mirror(signer, val("--mirror")!);
      console.log(`${val("--mirror")}: mirror ${r.mint} (mainnet ${r.real}), multiplier ${r.multiplier}, feed ${r.feedId}`);
    }
    if (!argv.length) console.log(await readRegistry() ?? "no registry");
  } catch (e) {
    console.error("failed:", errName(e));
    process.exit(1);
  }
}
