# Rambu: Stocklana submission

**Live demo:** https://rambu-kappa.vercel.app · **Code:** https://github.com/PugarHuda/rambu

**One-liner:** Fair prices for tokenized stocks, and an honest P&L for the people who LP them.

**Tracks:** Main (Infrastructure: price feeds, corporate actions, analytics), Pyth.

## Problem
- **Oracles miss dividends between the ex-date and the multiplier update.** SPY went ex-dividend $1.889 on 18 Sep 2026. On 19 Sep the SPYx mint still carried June's multiplier, so any `underlying × multiplier` price read 17.3bp low. Kamino, which prices SPYx through Scope, read 18.3bp low on $4.6M of SPYx deposits, and it did not suspend the reserve. Pyth's own `SPYX/SPY.RR` push account had not updated since 21 Jul.
- **LPs cannot see what they actually earn.** Raydium shows a gross APR. It does not subtract the protocol cut or what arbitrage takes (LVR), and it does not say when during the day the money is made or lost.

## What we built
1. **FairPrice.** Underlying price (Pyth Pro where the key is entitled, a clearly labeled fallback otherwise) × the mint's Token-2022 multiplier, plus any dividend that is ex but not yet in the multiplier. Every stock carries a status: `Open`, `Closed`, `Halted`, `Stale` or `CorpActionPending`. Market sessions come from Pyth's `market_session_schedule`.
2. **Onchain guard.** A keeper writes FairPrice and status into the `rambu` program on devnet. A protocol CPIs `assert_tradable_v2(mint, price, flags, max_age, max_band)` to block a liquidation or swap when the stock is halted, the state is stale, a corporate event is pending, the session is closed, or the price is outside the band. Lenders can only tighten the keeper's limits. `get_price` returns the reference as return data. `assert_tradable_verified` takes the price from a Pyth Pro payload verified in the same transaction instead of from the caller.
3. **LP Audit.** Replays 30 days of the SPYx/USDC Raydium CLMM pools minute by minute. Fees minus LVR are attributed to every live position and split by Pyth session. The MMR split shows how much of the LVR arbitrageurs keep and how much returns to LPs as fees.
4. **Open access.** A JSON API (`/api/state`, `/api/fair`, `/api/history` with an Atom feed) and two Solana Actions. The `tradable` Blink returns the program's own verdict from a devnet simulation. The `lp` Blink audits the connected wallet's positions, including live uncollected fees read from the position, pool and tick-array accounts.

## Results (live mainnet data, 19 Sep 2026)
- **Lender oracles on SPYx.** Jupiter Lend (Chainlink Data Streams) was 0.8bp from FairPrice. Kamino (Scope) was 18.3bp low, the naive number, which misvalues about $8.4k of deposits. The naive oracle itself was 17.3bp off.
- **Pyth Pro on the entitled feeds.** QQQx FairPrice from Pyth Pro (724.03) matched Chainlink to 0.01bp. TSLAx was 1.85bp from Chainlink.
- **10bp pool, 30 days.** $55.4k of LP fees against $16.5k of LVR, **+$38.9k net**. Post-market, overnight and the weekend pass a 95% CI gate.
- **1bp pool, 30 days.** +$4.4k net. The regular session (−$411) and pre-market (−$477) lose money. Post-market and the weekend earn, and both pass the gate.
- **Pool candles cannot be used for LVR.** Minute closes jump in ±25/±50bp clusters and overstate LVR by 20–60×. We use an external fair path instead: Pyth Pro minute bars where entitled, otherwise SPY 5-minute prints, ES futures overnight, with bad prints removed.

## Why Solana
- The mint's Token-2022 `ScaledUiAmount` and `Pausable` state are read directly, including onchain inside `assert_tradable_verified`.
- CLMM position state is public, so every LP can be audited without their cooperation, down to the fees still owed.
- `assert_tradable_v2` is one CPI inside a lender's liquidation transaction. Blinks let anyone run it from a link.

## Demo script (3 min)
1. **0:00, the problem.** Explorer: SPYx mint multiplier 1.005714 (June). SPY dividend on 18 Sep. The FairPrice board shows SPYx `CorpActionPending`. The lender table shows Kamino −18.3bp and Jupiter −0.8bp.
2. **0:40, onchain.** Open the `tradable` Blink on dial.to:
   - SPYx at $767.37 as a lender: `Tradable`.
   - SPYx at $680: `OutsideBand`.
   - SPYx with "regular session only": `SessionClosed` on a weekend.
   - QQQx: `Halted` (issuer halt).

   Each verdict comes from the program in a devnet simulation, and the Blink shows the logs and compute units.
3. **1:30, LP Audit.** Session table for both pools. Paste a wallet: position `CsveLY…AiV5` earned $7,570 of fees against $720 of LVR (+$6,850 net) and is in range now.
4. **2:20, method and honesty.** Why pool candles mislead, the MMR split, and which inputs are unofficial (Yahoo history and dividends outside the Pyth Pro entitlement).
5. **2:45, integrate.** PDA seeds, the CPI snippet, `curl /api/state?ticker=SPYx` and the Atom feed of status changes.

## Deployed (devnet)
- **`rambu`:** [`5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm`](https://explorer.solana.com/address/5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm?cluster=devnet), with `assert_tradable`, `assert_tradable_v2`, `get_price` and `assert_tradable_verified`. Pyth Pro feed links are set for QQQ (1363) and TSLA (1435).
- **`vault_demo`:** [`EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz`](https://explorer.solana.com/address/EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz?cluster=devnet), a lender that liquidates only through `assert_tradable_v2` (300 s, 200bp, regular session) or the verified path.
- **SPYx liquidation at FairPrice, passes:** [tx](https://explorer.solana.com/tx/4i7Y6BEdhtCbFXgL4PCBZJNKAnZHAjK7a54Lp3ZGFuHZtYZQdBjoYhTZHeyreA8Jh3N8nJhjXGJdM6hrBE8nbx3W?cluster=devnet)
- **Pyth-verified path, lands onchain:** [`assert_tradable_verified` on QQQx](https://explorer.solana.com/tx/pY1LSbMuvFDn9m97UGSCWzVssNBfxooj22S86BqdtJDzaEXNXDRs9JAcnNCuxaXbDkEavtXp93ykgzpgdDgQg7g?cluster=devnet) — a signed Pyth Pro payload (feed 1363) verified by Pyth's Lazer program as a CPI, 31,703 CU, price 724.561184 matching the keeper's reference. A TSLA payload passed for QQQx gives `FeedMismatch`; flipping one byte after signing is rejected by the Ed25519 program.
- **`get_price` returns the reference as return data:** [tx](https://explorer.solana.com/tx/2qv8SUpqXvaCyM7bZN7uTQJHPBktHJdpzkWmoBughVd4HW5U4cceqBaUtjS858aF4kZCuo9tRW4Tc2nfagL5faTr?cluster=devnet) (`ref_e6=724561184, expo=-6`)
- **Liquidation 0.5% off FairPrice passes, 3% off is `OutsideBand`:** [tx](https://explorer.solana.com/tx/3kJkiCj7gtLChrEDAaD6K9cHFrU2rmospsYkzLcdHppjb7iBt7HY9B6ZFXqw2uJtvhC5fdezS4ZKETsUCHg4fdkv?cluster=devnet)
- **`verify-chain.ts`** replays all of these against the deployed programs: 19 cases, all passing.
- **Keeper history:** `https://rambu-kappa.vercel.app/api/history?format=atom`

## Status and limits
- **Pyth Pro entitlement.** The free key covers the QQQ and TSLA equity feeds. Other tickers use a labeled fallback (stale push accounts, then the xStocks mark).
- **LP Audit.** The position set is today's; positions closed during the 30-day window are not replayed.
- **Keeper trust.** One keeper key writes state (`GUAsypz1MQLzqgkagt4EQi6CkaULzhae9Q946h13voT8`, separate from the upgrade authority since the 20 Sep rotation). The program bounds its parameters, and lenders can tighten them per call.
