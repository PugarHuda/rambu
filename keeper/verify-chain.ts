// End-to-end checks of the deployed devnet programs. Every case sends a real transaction and reads the program's verdict.
// usage: node --env-file=.env verify-chain.ts
// The rule cases (b) run on the QQQx devnet mirror with the live FairPrice ref but a fixed rule-test status (open,
// regular session), so they can run any day. The run ends by writing the mirror's live status back.
import { generateKeyPairSigner, type Address } from "@solana/kit";
import { AccountRole, RAMBU, SYSTEM, VAULT, disc, pubkeyBytes, statePda } from "./chain.ts";
import {
  IX_SYSVAR, PYTH_LAZER, PYTH_STORAGE, REQUIRE_REGULAR_SESSION, SESSION, admin, argBytes, ed25519Ix, errName, eventDisc,
  feedPda, lazerMessage, liveMirrorState, mirror, pythAccounts, readRegistry, readState, sendIxs, simulateIxs, upsertIx, vecU8, type Ix, type Upsert,
} from "./admin.ts";

if (!VAULT) throw new Error("VAULT_PROGRAM_ID missing");
const { u16, u32, u64 } = argBytes;
const payer = await admin();
const results: [string, boolean, string][] = [];
const pass = (name: string, ok: boolean, detail: string) => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); };
const expectErr = async (name: string, want: string, f: () => Promise<string>) => {
  try { pass(name, false, `landed ${await f()}, expected ${want}`); } catch (e) { const got = errName(e); pass(name, got === want, `-> ${got}`); }
};
const expectRejected = async (name: string, f: () => Promise<string>) => {
  try { pass(name, false, `landed ${await f()}`); } catch (e) { pass(name, true, `-> ${errName(e).slice(0, 120)}`); }
};
const expectOk = async (name: string, f: () => Promise<string>) => {
  try { const sig = await f(); pass(name, true, `https://explorer.solana.com/tx/${sig}?cluster=devnet`); return sig; } catch (e) { pass(name, false, `-> ${errName(e)}`); }
};
const events = (logs: string[]) => logs.filter((l) => l.startsWith("Program data: ")).map((l) => Buffer.from(l.slice(14), "base64").subarray(0, 8).toString("hex"));

const reg = await readRegistry();
if (reg?.keeper !== payer.address) throw new Error(`signer ${payer.address} is not the registry keeper (${reg?.keeper})`);

const q = await mirror(payer, "QQQx");
const t = await mirror(payer, "TSLAx");
const live = await liveMirrorState("QQQx", q.x);
console.log(`QQQx mirror ${q.mint}: multiplier ${q.multiplier}, live FairPrice ref ${Number(live.refPriceE6) / 1e6}, live status halt=${live.halt}:${live.haltCode || "-"} session=${live.session}`);
if (!live.refPriceE6) throw new Error("no live FairPrice for QQQx: cannot set a reference");
const upsert = async (mint: Address, s: Upsert) => sendIxs(payer, [await upsertIx(payer, mint, s)]);
const fixture: Upsert = { ...live, ticker: "QQQx-dev", session: SESSION.regular, halt: 0, haltCode: "" };

// The cases below write the open fixture to a state the web board reads, so a run that dies partway would leave the
// mirror claiming QQQx is tradable while the issuer has it halted. sendAndConfirm has no timeout and hangs for good
// when the devnet websocket drops, which exits the process without unwinding. This watchdog is deliberately not
// unref'd: the pending timer keeps the process alive long enough to put the live status back, then fails the run.
const STALL_MIN = Number(process.env.STALL_MIN ?? 10);
const watchdog = setTimeout(async () => {
  await upsert(q.mint, live).catch((e) => console.error(`mirror restore failed: ${e.message}`));
  console.error(`\nverify-chain stalled after ${STALL_MIN} min; QQQx mirror restored to its live status (halt=${live.halt}:${live.haltCode || "-"})`);
  process.exit(1);
}, STALL_MIN * 60_000);

// (a) only the registry keeper can write state
const intruder = await generateKeyPairSigner();
await expectErr("(a) upsert signed by a non-keeper is rejected", "ConstraintHasOne", async () => {
  const ix = await upsertIx(intruder, q.mint, fixture);
  return sendIxs(payer, [ix]);
});
await expectErr("(a) upsert with band 5000bps is rejected", "BadParam", () => upsert(q.mint, { ...fixture, bandBps: 5000 }));

// events: a status change emits StateChanged, an identical rewrite only a Heartbeat (logs via simulation of the same tx)
const evName = async (s: Upsert) => { const ev = events((await simulateIxs(payer, [await upsertIx(payer, q.mint, s)])).logs);
  return ev.includes(eventDisc("StateChanged").toString("hex")) ? "StateChanged" : ev.includes(eventDisc("Heartbeat").toString("hex")) ? "Heartbeat" : "none"; };
await upsert(q.mint, fixture);
const [same, moved] = [await evName(fixture), await evName({ ...fixture, refPriceE6: fixture.refPriceE6 + 1n })];
pass("(e) unchanged upsert -> Heartbeat, changed ref -> StateChanged", same === "Heartbeat" && moved === "StateChanged", `${same} / ${moved}`);

// (b) vault_demo.liquidate -> rambu.assert_tradable_v2(300s, 200bps, REQUIRE_REGULAR_SESSION)
const openPosition = async (mint: Address) => {
  const position = await generateKeyPairSigner();
  await sendIxs(payer, [{ programAddress: VAULT, data: Buffer.concat([disc("open_position"), pubkeyBytes(mint)]), accounts: [
    { address: position.address, role: AccountRole.WRITABLE_SIGNER, signer: position },
    { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM, role: AccountRole.READONLY },
  ] }]);
  return position.address;
};
const liquidate = async (position: Address, mint: Address, priceE6: bigint) => sendIxs(payer, [{ programAddress: VAULT, data: Buffer.concat([disc("liquidate"), u64(priceE6)]), accounts: [
  { address: position, role: AccountRole.WRITABLE },
  { address: await statePda(mint), role: AccountRole.READONLY },
  { address: RAMBU, role: AccountRole.READONLY },
  { address: payer.address, role: AccountRole.READONLY_SIGNER },
] }]);
const v2 = async (mint: Address, priceE6: bigint, flags: number) => sendIxs(payer, [{ programAddress: RAMBU,
  data: Buffer.concat([disc("assert_tradable_v2"), pubkeyBytes(mint), u64(priceE6), Buffer.from([flags]), u32(0), u16(0)]),
  accounts: [{ address: await statePda(mint), role: AccountRole.READONLY }] }]);

const ref = fixture.refPriceE6;
const pos = await openPosition(q.mint);
await expectErr("(b) liquidate at price 0", "PriceRequired", () => liquidate(pos, q.mint, 0n));
await expectErr("(b) rambu v2 lender check at price 0", "PriceRequired", () => v2(q.mint, 0n, 0));
await expectErr("(b) liquidate 3% off FairPrice (vault band 2%)", "OutsideBand", () => liquidate(pos, q.mint, (ref * 103n) / 100n));
await expectErr("(b) v2 naming TSLAx but passing the QQQx state", "ConstraintSeeds", async () => sendIxs(payer, [{ programAddress: RAMBU,
  data: Buffer.concat([disc("assert_tradable_v2"), pubkeyBytes(t.mint), u64(ref), Buffer.from([0]), u32(0), u16(0)]),
  accounts: [{ address: await statePda(q.mint), role: AccountRole.READONLY }] }]));
await expectOk("(b) liquidate 0.5% off FairPrice", () => liquidate(pos, q.mint, (ref * 1005n) / 1000n));
await expectErr("(b) liquidate the same position twice", "AlreadyLiquidated", () => liquidate(pos, q.mint, ref));
await upsert(q.mint, { ...fixture, session: SESSION.closed });
const pos2 = await openPosition(q.mint);
await expectErr("(b) liquidate while the session is closed", "SessionClosed", () => liquidate(pos2, q.mint, ref));

// get_price returns (ref_e6, -6, updated_at) as return data
await upsert(q.mint, fixture);
const gpIx = { programAddress: RAMBU, data: Buffer.concat([disc("get_price"), pubkeyBytes(q.mint)]), accounts: [{ address: await statePda(q.mint), role: AccountRole.READONLY }] };
const gp = await expectOk("(b) get_price", () => sendIxs(payer, [gpIx]));
if (gp) {
  const rd = (await simulateIxs(payer, [gpIx])).returnData ?? Buffer.alloc(0);
  pass("(b) get_price return data = onchain ref", rd.length === 20 && rd.readBigUInt64LE(0) === ref && rd.readInt32LE(8) === -6, `ref_e6=${rd.length === 20 ? rd.readBigUInt64LE(0) : "?"} expo=${rd.length === 20 ? rd.readInt32LE(8) : "?"}`);
}

// (c) verified path: Pyth Pro signed payload, Ed25519 precompile ix + Pyth Lazer CPI, multiplier from the mint account
const { treasury } = await pythAccounts();
const pythMetas = (signer = true) => [
  { address: payer.address, role: signer ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE },
  { address: PYTH_LAZER, role: AccountRole.READONLY },
  { address: PYTH_STORAGE, role: AccountRole.READONLY },
  { address: treasury, role: AccountRole.WRITABLE },
  { address: SYSTEM, role: AccountRole.READONLY },
  { address: IX_SYSVAR, role: AccountRole.READONLY },
];
const verifiedIx = async (mint: Address, msg: Buffer, flags: number): Promise<Ix> => ({
  programAddress: RAMBU,
  data: Buffer.concat([disc("assert_tradable_verified"), vecU8(msg), u16(0), Buffer.from([flags]), u32(300), u16(200)]),
  accounts: [
    { address: await statePda(mint), role: AccountRole.READONLY },
    { address: await feedPda(mint), role: AccountRole.READONLY },
    { address: mint, role: AccountRole.READONLY },
    ...pythMetas(),
  ],
});
const verified = async (mint: Address, feedId: number, flags = 0) => { const m = await lazerMessage(feedId); return sendIxs(payer, [ed25519Ix(m, 1), await verifiedIx(mint, m, flags)]); };

// QQQx on the rule fixture (open), Pyth's own session from the payload
await upsert(q.mint, { ...fixture, session: live.session });
const vs = await expectOk("(c) assert_tradable_verified QQQx (Pyth Pro 1363 × mirror multiplier) lands", () => verified(q.mint, q.feedId));
if (vs) {
  const m = await lazerMessage(q.feedId);
  const sim = await simulateIxs(payer, [ed25519Ix(m, 1), await verifiedIx(q.mint, m, 0)]);
  const vp = sim.logs.map((l) => l.startsWith("Program data: ") ? Buffer.from(l.slice(14), "base64") : undefined).find((b) => b?.subarray(0, 8).equals(eventDisc("VerifiedPrice")));
  pass("(c) Pyth Lazer verify_message ran as a CPI; VerifiedPrice emitted", sim.logs.some((l) => l.includes(`Program ${PYTH_LAZER} success`)) && !!vp,
    `price_e6=${vp ? vp.readBigUInt64LE(8 + 32 + 4) : "?"} (FairPrice ref ${Number(ref) / 1e6}), ${sim.units} CU`);
}
await expectErr("(c) TSLA payload presented for QQQx", "FeedMismatch", () => verified(q.mint, t.feedId));
await expectRejected("(c) tampered payload (one byte flipped after signing)", async () => {
  const m = await lazerMessage(q.feedId);
  const ix = await verifiedIx(q.mint, m, 0);
  const bad = Buffer.from(ix.data); bad[12 + 102 + 14] ^= 1; // flip a byte inside the signed payload
  return sendIxs(payer, [ed25519Ix(m, 1), { ...ix, data: bad }]);
});
const sessionName = Object.entries(SESSION).find(([, v]) => v === live.session)?.[0];
const posV = await openPosition(q.mint);
const liqVerified = async () => { const m = await lazerMessage(q.feedId); return sendIxs(payer, [ed25519Ix(m, 1), { programAddress: VAULT,
  data: Buffer.concat([disc("liquidate_verified"), vecU8(m), u16(0)]),
  accounts: [
    { address: posV, role: AccountRole.WRITABLE },
    { address: await statePda(q.mint), role: AccountRole.READONLY },
    { address: await feedPda(q.mint), role: AccountRole.READONLY },
    { address: q.mint, role: AccountRole.READONLY },
    { address: RAMBU, role: AccountRole.READONLY },
    ...pythMetas(),
  ] }]); };
if (live.session === SESSION.regular) await expectOk("(c) vault liquidate_verified QQQx (regular session)", liqVerified);
else await expectErr(`(c) vault liquidate_verified QQQx outside regular hours (Pyth says ${sessionName})`, "SessionClosed", liqVerified);

// live status written back: QQQx mirror as FairPrice sees it now, TSLAx mirror too, then the verified path on live states
await upsert(q.mint, live);
const tl = await liveMirrorState("TSLAx", t.x);
await upsert(t.mint, tl);
for (const [sym, st, m, feed] of [["QQQx", live, q.mint, q.feedId], ["TSLAx", tl, t.mint, t.feedId]] as const) {
  const name = `(c) verified ${sym} on its live state (halt=${st.halt}:${st.haltCode || "-"})`;
  if (st.halt) await expectErr(name, "Halted", () => verified(m, feed));
  else await expectOk(name, () => verified(m, feed));
}

clearTimeout(watchdog); // the mirror is back on its live status; no restore needed
const onchain = await readState(q.mint);
console.log(`\nQQQx mirror state now: halt=${onchain?.halt}:${onchain?.haltCode || "-"} session=${onchain?.session} ref=${Number(onchain?.refPriceE6 ?? 0) / 1e6}`);
const failed = results.filter(([, ok]) => !ok);
console.log(`${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
