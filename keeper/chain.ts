// Minimal Solana plumbing shared by keeper and demo (no Anchor client needed: manual discriminators + Borsh).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc,
  createSolanaRpcSubscriptions, createTransactionMessage, getAddressEncoder, getProgramDerivedAddress,
  getSignatureFromTransaction, pipe, sendAndConfirmTransactionFactory, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, AccountRole,
  type Address, type KeyPairSigner,
} from "@solana/kit";

export { address, AccountRole };
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
