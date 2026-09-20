// Minimal Solana plumbing shared by keeper and demo (no Anchor client needed: manual discriminators + Borsh).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  address, appendTransactionMessageInstructions, getAddressDecoder, createKeyPairSignerFromBytes, createSolanaRpc,
  createSolanaRpcSubscriptions, createTransactionMessage, getAddressEncoder, getProgramDerivedAddress,
  getSignatureFromTransaction, pipe, sendAndConfirmTransactionFactory, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, AccountRole,
  type Address, type KeyPairSigner,
} from "@solana/kit";

export { address, AccountRole, getAddressDecoder };
export const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const rpc = createSolanaRpc(RPC);
const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(process.env.WS_URL ?? RPC.replace(/^http/, "ws")) });

export const SYSTEM = address("11111111111111111111111111111111");
export const RAMBU = address(process.env.RAMBU_PROGRAM_ID!);
export const VAULT = process.env.VAULT_PROGRAM_ID ? address(process.env.VAULT_PROGRAM_ID) : undefined;

export const loadSigner = (path: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
export const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const pubkeyBytes = (a: Address) => getAddressEncoder().encode(a) as Uint8Array;
export const pda = async (program: Address, ...seeds: (string | Uint8Array)[]) =>
  (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
export const statePda = (mint: Address) => pda(RAMBU, "rambu", pubkeyBytes(mint));

export type Meta = { address: Address; role: AccountRole; signer?: KeyPairSigner };

export async function sendIx(payer: KeyPairSigner, program: Address, data: Uint8Array, accounts: Meta[]) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const ix = {
    programAddress: program,
    data,
    // kit picks up extra signers from account metas that carry a `signer`
    accounts: accounts.map((a) => (a.signer ? { address: a.address, role: a.role, signer: a.signer } : { address: a.address, role: a.role })),
  };
  const tx = await signTransactionMessageWithSigners(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions([ix as any], m),
  ));
  await send(tx as any, { commitment: "confirmed" });
  return getSignatureFromTransaction(tx);
}

// Pull program logs out of a failed preflight so demos can show the Rambu error.
export const logsOf = (e: any): string[] => e?.cause?.context?.logs ?? e?.context?.logs ?? [];

// StockState account (118 bytes), same layout as web decodeState: disc 8 | mint 32 | ticker 12 | session | halt |
// halt_code 4 | halted_at i64 | resume_at i64 | event | event_ref 20 | ref_price_e6 u64 @95 | band u16 @103 | max_age u32 @105 | updated_at i64 @109
export type OnchainState = { ticker: string; session: number; halt: number; haltCode: string; haltedAt: number; resumeAt: number; event: number; eventRef: string; refPriceE6: bigint; bandBps: number; maxAgeS: number; updatedAt: number };
const str = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0+$/, "");
export function decodeState(b: Uint8Array): OnchainState {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    ticker: str(b.subarray(40, 52)), session: b[52], halt: b[53], haltCode: str(b.subarray(54, 58)),
    haltedAt: Number(v.getBigInt64(58, true)), resumeAt: Number(v.getBigInt64(66, true)),
    event: b[74], eventRef: str(b.subarray(75, 95)), refPriceE6: v.getBigUint64(95, true),
    bandBps: v.getUint16(103, true), maxAgeS: v.getUint32(105, true), updatedAt: Number(v.getBigInt64(109, true)),
  };
}

// Current onchain state per mint (undefined = never pushed). One RPC call for all tracked stocks.
export async function readStates(mints: Address[]): Promise<(OnchainState | undefined)[]> {
  const keys = await Promise.all(mints.map(statePda));
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: "base64" }).send();
  return value.map((a) => (a ? decodeState(Buffer.from(a.data[0], "base64")) : undefined));
}

export type Next = { session: number; halt: number; haltCode: string; haltedAtS: number; resumeAtS: number; event: number; eventRef: string; refPriceE6: bigint };
// Why the onchain state must be rewritten, [] = leave it. Alert-worthy: halt, event, ref, missed.
export function pushReasons(prev: OnchainState | undefined, n: Next, cfg: { bandBps: number; maxAgeS: number }, nowS: number): string[] {
  if (!prev) return ["new"];
  const out: string[] = [];
  if (nowS - prev.updatedAt > prev.maxAgeS) out.push("missed");
  if (prev.halt !== n.halt || prev.haltCode !== n.haltCode || prev.haltedAt !== n.haltedAtS || prev.resumeAt !== n.resumeAtS) out.push("halt");
  if (prev.event !== n.event || prev.eventRef !== n.eventRef) out.push("event");
  if (prev.session !== n.session) out.push("session");
  const p = Number(prev.refPriceE6), q = Number(n.refPriceE6);
  if (Math.abs(q - p) * 1e4 * 4 > p * cfg.bandBps || (p === 0) !== (q === 0)) out.push("ref"); // quarter of the band
  if (prev.bandBps !== cfg.bandBps || prev.maxAgeS !== cfg.maxAgeS) out.push("config");
  if (nowS - prev.updatedAt > cfg.maxAgeS / 3) out.push("age"); // refresh well before assert_tradable calls it Stale
  return out;
}
