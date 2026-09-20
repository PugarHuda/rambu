// Demo: a lending vault tries to liquidate a position. Rambu blocks it while the stock is halted, stale, off-session
// or the price is outside the band around FairPrice.
// usage: node --env-file=.env demo.ts SPYx [price]   price defaults to the onchain FairPrice ref, never 0
//        node --env-file=.env demo.ts QQQx --verified liquidate at a Pyth Pro price verified in the tx (QQQx, TSLAx)
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { AccountRole, RAMBU, SYSTEM, VAULT, address, disc, pubkeyBytes, statePda } from "./chain.ts";
import {
  IX_SYSVAR, PYTH_LAZER, PYTH_STORAGE, admin, ed25519Ix, errName, feedPda, lazerMessage, liveMirrorState, mirror,
  pythAccounts, readState, sendIxs, upsertIx, vecU8, argBytes,
} from "./admin.ts";
import { fetchXStocks } from "./sources.ts";

const args = process.argv.slice(2);
const verified = args.includes("--verified");
const [symbol = "NVDAx", priceArg] = args.filter((a) => !a.startsWith("--"));
const payer = await admin();
if (!VAULT) throw new Error("VAULT_PROGRAM_ID missing");
const ok = (sig: string) => console.log(`✓ liquidation executed: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
const blocked = (e: unknown) => console.log(`✗ liquidation blocked by Rambu → ${errName(e)}`);

async function openPosition(mint: Address) {
  const position = await generateKeyPairSigner();
  await sendIxs(payer, [{ programAddress: VAULT!, data: Buffer.concat([disc("open_position"), pubkeyBytes(mint)]), accounts: [
    { address: position.address, role: AccountRole.WRITABLE_SIGNER, signer: position },
    { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
  ] }]);
  console.log(`opened position ${position.address} on ${symbol}`);
  return position.address;
}

if (verified) {
  // xStocks mints live on mainnet only; devnet uses the mirror mint carrying the same multiplier (admin.ts --mirror)
  const m = await mirror(payer, symbol);
  // the keeper tracks mainnet mints; refresh the mirror's state from live FairPrice so the check runs on today's status
  const st = await liveMirrorState(symbol, m.x);
  await sendIxs(payer, [await upsertIx(payer, m.mint, st)]);
  console.log(`${symbol} mirror ${m.mint}: FairPrice ref ${Number(st.refPriceE6) / 1e6}, halt=${st.halt}:${st.haltCode || "-"}, session=${st.session}`);
  const position = await openPosition(m.mint);
  const msg = await lazerMessage(m.feedId);
  const { treasury } = await pythAccounts();
  try {
    ok(await sendIxs(payer, [ed25519Ix(msg, 1), { programAddress: VAULT, data: Buffer.concat([disc("liquidate_verified"), vecU8(msg), argBytes.u16(0)]), accounts: [
      { address: position, role: AccountRole.WRITABLE },
      { address: await statePda(m.mint), role: AccountRole.READONLY },
      { address: await feedPda(m.mint), role: AccountRole.READONLY },
      { address: m.mint, role: AccountRole.READONLY },
      { address: RAMBU, role: AccountRole.READONLY },
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: PYTH_LAZER, role: AccountRole.READONLY },
      { address: PYTH_STORAGE, role: AccountRole.READONLY },
      { address: treasury, role: AccountRole.WRITABLE },
      { address: SYSTEM, role: AccountRole.READONLY },
      { address: IX_SYSVAR, role: AccountRole.READONLY },
    ] }]));
  } catch (e) { blocked(e); }
} else {
  const x = (await fetchXStocks()).find((s) => s.symbol === symbol);
  if (!x) throw new Error(`unknown symbol ${symbol}`);
  const mint = address(x.mint);
  const st = await readState(mint);
  if (!st) throw new Error(`no Rambu state for ${symbol} on devnet: run the keeper first`);
  const priceE6 = priceArg ? BigInt(Math.round(Number(priceArg) * 1e6)) : st.refPriceE6;
  if (!priceE6) throw new Error(`${symbol} has no onchain reference (halt ${st.haltCode || st.halt}): pass a price`);
  console.log(`${symbol} onchain: ref ${Number(st.refPriceE6) / 1e6}, halt=${st.halt}:${st.haltCode || "-"}, session=${st.session}, updated ${Math.round(Date.now() / 1000 - st.updatedAt)}s ago; liquidating at ${Number(priceE6) / 1e6}`);
  const position = await openPosition(mint);
  try {
    ok(await sendIxs(payer, [{ programAddress: VAULT, data: Buffer.concat([disc("liquidate"), argBytes.u64(priceE6)]), accounts: [
      { address: position, role: AccountRole.WRITABLE },
      { address: await statePda(mint), role: AccountRole.READONLY },
      { address: RAMBU, role: AccountRole.READONLY },
      { address: payer.address, role: AccountRole.READONLY_SIGNER },
    ] }]));
  } catch (e) { blocked(e); }
}
