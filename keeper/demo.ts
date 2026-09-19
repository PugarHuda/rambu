// Demo: a lending vault tries to liquidate a position. Rambu blocks it while the stock is halted.
// usage: node --env-file=.env demo.ts NVDAx 212.40
import { generateKeyPairSigner } from "@solana/kit";
import { AccountRole, RAMBU, SYSTEM, VAULT, address, disc, loadSigner, logsOf, pubkeyBytes, sendIx, statePda } from "./chain.ts";
import { fetchXStocks } from "./sources.ts";

const [symbol = "NVDAx", priceArg = "0"] = process.argv.slice(2);
const payer = await loadSigner(process.env.KEEPER_KEYPAIR!);
const x = (await fetchXStocks()).find((s) => s.symbol === symbol);
if (!x || !VAULT) throw new Error(`unknown symbol ${symbol} or VAULT_PROGRAM_ID missing`);
const mint = address(x.mint);

const position = await generateKeyPairSigner();
await sendIx(payer, VAULT, Buffer.concat([disc("open_position"), pubkeyBytes(mint)]), [
  { address: position.address, role: AccountRole.WRITABLE_SIGNER, signer: position },
  { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
  { address: SYSTEM, role: AccountRole.READONLY },
]);
console.log(`opened position ${position.address} on ${symbol}`);

const price = Buffer.alloc(8);
price.writeBigUInt64LE(BigInt(Math.round(Number(priceArg) * 1e6)));
try {
  const sig = await sendIx(payer, VAULT, Buffer.concat([disc("liquidate"), price]), [
    { address: position.address, role: AccountRole.WRITABLE },
    { address: await statePda(mint), role: AccountRole.READONLY },
    { address: RAMBU, role: AccountRole.READONLY },
    { address: payer.address, role: AccountRole.READONLY_SIGNER },
  ]);
  console.log(`✓ liquidation executed: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
} catch (e: any) {
  const why = logsOf(e).find((l) => l.includes("Error Message")) ?? e.message;
  console.log(`✗ liquidation blocked by Rambu → ${why}`);
}
