use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::{invoke, set_return_data}};

declare_id!("5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm");

pub const HALT_NONE: u8 = 0;
pub const HALT_HARD: u8 = 1;
pub const HALT_SOFT: u8 = 2;
pub const HALT_ISSUER: u8 = 3;
pub const SESSION_REGULAR: u8 = 2;
pub const SESSION_MAX: u8 = 5; // 0 unknown, 1 pre, 2 regular, 3 post, 4 overnight, 5 closed

// assert_tradable_v2 / _verified flags
pub const IGNORE_EVENTS: u8 = 1;
pub const REQUIRE_REGULAR_SESSION: u8 = 2;

// Pyth Lazer (Pyth Pro) verifier, same ids on devnet and mainnet
pub const PYTH_LAZER: Pubkey = pubkey!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
pub const PYTH_STORAGE: Pubkey = pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
pub const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
// sha256("global:verify_message")[..8]
pub const VERIFY_MESSAGE_DISC: [u8; 8] = [180, 193, 120, 55, 189, 135, 203, 83];
pub const IX_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

#[program]
pub mod rambu {
    use super::*;

    /// Only the program's upgrade authority can create the registry (no front-running the init).
    pub fn init_registry(ctx: Context<InitRegistry>, keeper: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.authority = ctx.accounts.authority.key();
        r.keeper = keeper;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn set_keeper(ctx: Context<SetAdmin>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.registry.keeper = keeper;
        Ok(())
    }

    pub fn set_authority(ctx: Context<SetAdmin>, authority: Pubkey) -> Result<()> {
        ctx.accounts.registry.authority = authority;
        Ok(())
    }

    /// Binds a mint to its Pyth Pro feed id, so a verified payload for another stock can't be passed off.
    pub fn set_feed(ctx: Context<SetFeed>, mint: Pubkey, feed_id: u32) -> Result<()> {
        let f = &mut ctx.accounts.feed;
        f.mint = mint;
        f.feed_id = feed_id;
        f.bump = ctx.bumps.feed;
        Ok(())
    }

    // ponytail: single trusted keeper; quorum of keepers / CRE workflow is the upgrade path
    pub fn upsert(ctx: Context<Upsert>, a: UpsertArgs) -> Result<()> {
        validate(&a)?;
        let s = &mut ctx.accounts.state;
        let prev_ref = s.ref_price_e6;
        let changed = s.mint == Pubkey::default()
            || (s.ticker, s.session, s.halt, s.halt_code, s.halted_at, s.resume_at, s.event, s.event_ref, s.ref_price_e6, s.band_bps, s.max_age_s)
                != (a.ticker, a.session, a.halt, a.halt_code, a.halted_at, a.resume_at, a.event, a.event_ref, a.ref_price_e6, a.band_bps, a.max_age_s);
        s.mint = ctx.accounts.mint.key();
        s.ticker = a.ticker;
        s.session = a.session;
        s.halt = a.halt;
        s.halt_code = a.halt_code;
        s.halted_at = a.halted_at;
        s.resume_at = a.resume_at;
        s.event = a.event;
        s.event_ref = a.event_ref;
        s.ref_price_e6 = a.ref_price_e6;
        s.band_bps = a.band_bps;
        s.max_age_s = a.max_age_s;
        s.updated_at = Clock::get()?.unix_timestamp;
        s.bump = ctx.bumps.state;
        if changed {
            emit!(StateChanged {
                mint: s.mint, halt: s.halt, event: s.event, session: s.session, ref_price_e6: s.ref_price_e6, prev_ref_e6: prev_ref,
                band_bps: s.band_bps, max_age_s: s.max_age_s, halt_code: s.halt_code, event_ref: s.event_ref, updated_at: s.updated_at,
            });
        } else {
            emit!(Heartbeat { mint: s.mint, updated_at: s.updated_at });
        }
        Ok(())
    }

    /// v1, kept for existing integrations: state-only limits. Lenders must pass a price (price 0 fails PriceRequired);
    /// ignore_events=true is the swap path, where price 0 skips the band.
    pub fn assert_tradable(ctx: Context<AssertTradable>, price_e6: u64, ignore_events: bool) -> Result<()> {
        check(&ctx.accounts.state, Clock::get()?.unix_timestamp, price_e6, ignore_events)
    }

    /// v2: the caller names the mint (state PDA is derived from it) and can only tighten age/band; 0 = state value.
    pub fn assert_tradable_v2(ctx: Context<AssertTradableV2>, _mint: Pubkey, price_e6: u64, flags: u8, max_age_s: u32, max_band_bps: u16) -> Result<()> {
        check_with(&ctx.accounts.state, Clock::get()?.unix_timestamp, price_e6, flags, max_age_s, max_band_bps)
    }

    /// Same rules as a lender check, but returns (ref_price_e6: u64, expo: i32 = -6, updated_at: i64) as return data.
    pub fn get_price(ctx: Context<AssertTradableV2>, _mint: Pubkey) -> Result<()> {
        let r = price_of(&ctx.accounts.state, Clock::get()?.unix_timestamp)?;
        set_return_data(&[&r.0.to_le_bytes()[..], &r.1.to_le_bytes(), &r.2.to_le_bytes()].concat());
        Ok(())
    }

    /// Price comes from a Pyth Pro payload verified in this transaction (Ed25519 ix + Pyth Lazer CPI), not from the caller.
    /// `message` must stay the first arg: the Ed25519 ix points at it at offset 12 of the top-level ix data.
    pub fn assert_tradable_verified(ctx: Context<AssertTradableVerified>, message: Vec<u8>, ed25519_ix_index: u16, flags: u8, max_age_s: u32, max_band_bps: u16) -> Result<()> {
        let a = &ctx.accounts;
        let now = Clock::get()?.unix_timestamp;
        // order: onchain status (stale/halt/event/session) first, then the Pyth payload, then the band
        state_rules(&a.state, now, flags, max_age_s)?;
        let mut data = VERIFY_MESSAGE_DISC.to_vec();
        message.serialize(&mut data)?;
        ed25519_ix_index.serialize(&mut data)?;
        data.push(0); // signature_index
        invoke(
            &Instruction {
                program_id: PYTH_LAZER,
                accounts: vec![
                    AccountMeta::new(a.payer.key(), true),
                    AccountMeta::new_readonly(PYTH_STORAGE, false),
                    AccountMeta::new(a.pyth_treasury.key(), false),
                    AccountMeta::new_readonly(a.system_program.key(), false),
                    AccountMeta::new_readonly(IX_SYSVAR, false),
                ],
                data,
            },
            &[a.pyth_program.to_account_info(), a.payer.to_account_info(), a.pyth_storage.to_account_info(), a.pyth_treasury.to_account_info(), a.system_program.to_account_info(), a.instructions_sysvar.to_account_info()],
        )?;
        let p = parse_lazer(&message, a.feed.feed_id)?;
        let mult = scaled_multiplier(&a.mint.try_borrow_data()?, now)?;
        let price_e6 = verified_price(&p, &a.state, now, mult, flags, max_age_s, max_band_bps)?;
        band(&a.state, price_e6, flags, max_band_bps)?;
        emit!(VerifiedPrice { mint: a.state.mint, feed_id: p.feed_id, price_e6, publish_us: p.timestamp_us, market_session: p.session });
        Ok(())
    }
}

pub fn validate(a: &UpsertArgs) -> Result<()> {
    require!((10..=2000).contains(&a.band_bps), RambuError::BadParam);
    require!((60..=3600).contains(&a.max_age_s), RambuError::BadParam);
    require!(a.halt <= HALT_ISSUER && a.session <= SESSION_MAX, RambuError::BadParam);
    require!(a.halt != HALT_SOFT || a.resume_at > 0, RambuError::BadParam);
    Ok(())
}

/// lender limit: 0 = state value, otherwise the tighter of the two
fn tighter<T: Ord + Default>(state: T, lender: T) -> T {
    if lender == T::default() { state } else { state.min(lender) }
}

pub fn check(s: &StockState, now: i64, price_e6: u64, ignore_events: bool) -> Result<()> {
    check_with(s, now, price_e6, if ignore_events { IGNORE_EVENTS } else { 0 }, 0, 0)
}

pub fn check_with(s: &StockState, now: i64, price_e6: u64, flags: u8, max_age_s: u32, max_band_bps: u16) -> Result<()> {
    state_rules(s, now, flags, max_age_s)?;
    band(s, price_e6, flags, max_band_bps)
}

/// Status rules that don't need a price: stale, halt, pending event, session.
pub fn state_rules(s: &StockState, now: i64, flags: u8, max_age_s: u32) -> Result<()> {
    require!(now.saturating_sub(s.updated_at) <= tighter(s.max_age_s, max_age_s) as i64, RambuError::Stale);
    match s.halt {
        HALT_NONE => {}
        HALT_SOFT => require!(s.resume_at != 0 && now >= s.resume_at, RambuError::Paused),
        _ => return err!(RambuError::Halted),
    }
    require!(flags & IGNORE_EVENTS != 0 || s.event == 0, RambuError::EventPending);
    require!(flags & REQUIRE_REGULAR_SESSION == 0 || s.session == SESSION_REGULAR, RambuError::SessionClosed);
    Ok(())
}

pub fn band(s: &StockState, price_e6: u64, flags: u8, max_band_bps: u16) -> Result<()> {
    let ignore_events = flags & IGNORE_EVENTS != 0;
    if price_e6 == 0 {
        // price 0 used to skip the band: a lender could "check" without a price. Only swaps (ignore_events) may.
        require!(ignore_events, RambuError::PriceRequired);
        return Ok(());
    }
    require!(s.ref_price_e6 > 0, RambuError::NoReference);
    let diff = (price_e6 as i128 - s.ref_price_e6 as i128).unsigned_abs();
    require!(diff * 10_000 <= s.ref_price_e6 as u128 * tighter(s.band_bps, max_band_bps) as u128, RambuError::OutsideBand);
    Ok(())
}

/// get_price: lender rules (stale, halt, pending event) and a reference must exist.
pub fn price_of(s: &StockState, now: i64) -> Result<(u64, i32, i64)> {
    require!(s.ref_price_e6 > 0, RambuError::NoReference);
    check_with(s, now, s.ref_price_e6, 0, 0, 0)?;
    Ok((s.ref_price_e6, -6, s.updated_at))
}

#[derive(Debug, PartialEq)]
pub struct Lazer {
    pub timestamp_us: u64,
    pub feed_id: u32,
    pub price: i64,
    pub expo: i16,
    pub conf: i64,
    pub session: i16, // Pyth MarketSession: 0 regular, 1 pre, 2 post, 3 overnight, 4 closed
    pub feed_update_us: u64,
}

const SOLANA_MAGIC: u32 = 2182742457;
const PAYLOAD_MAGIC: u32 = 2479346549;

/// Parses a Pyth Lazer `solana` message (magic | sig 64 | pubkey 32 | u16 len | payload) for one feed.
/// The signature is checked by the Pyth Lazer program, not here.
pub fn parse_lazer(m: &[u8], feed_id: u32) -> Result<Lazer> {
    let mut o = 0usize;
    let mut take = |n: usize| -> Result<&[u8]> {
        let b = m.get(o..o + n).ok_or(error!(RambuError::BadPayload))?;
        o += n;
        Ok(b)
    };
    let u8_ = |b: &[u8]| b[0];
    let u16_ = |b: &[u8]| u16::from_le_bytes(b.try_into().unwrap());
    let u32_ = |b: &[u8]| u32::from_le_bytes(b.try_into().unwrap());
    let u64_ = |b: &[u8]| u64::from_le_bytes(b.try_into().unwrap());
    require!(u32_(take(4)?) == SOLANA_MAGIC, RambuError::BadPayload);
    take(96)?;
    let len = u16_(take(2)?) as usize;
    require!(m.len() == 102 + len, RambuError::BadPayload);
    require!(u32_(take(4)?) == PAYLOAD_MAGIC, RambuError::BadPayload);
    let timestamp_us = u64_(take(8)?);
    take(1)?; // channel
    let feeds = u8_(take(1)?);
    for _ in 0..feeds {
        let id = u32_(take(4)?);
        let props = u8_(take(1)?);
        let mut l = Lazer { timestamp_us, feed_id: id, price: 0, expo: 0, conf: 0, session: -1, feed_update_us: 0 };
        let mut have_expo = false;
        for _ in 0..props {
            match u8_(take(1)?) {
                0 => l.price = u64_(take(8)?) as i64,
                1 | 2 | 10 | 11 => { take(8)?; }
                3 => { take(2)?; }
                4 => { l.expo = u16_(take(2)?) as i16; have_expo = true; }
                5 => l.conf = u64_(take(8)?) as i64,
                6 | 7 | 8 => { if u8_(take(1)?) != 0 { take(8)?; } }
                9 => l.session = u16_(take(2)?) as i16,
                12 => { if u8_(take(1)?) != 0 { l.feed_update_us = u64_(take(8)?); } }
                _ => return err!(RambuError::BadPayload),
            }
        }
        if id == feed_id {
            require!(have_expo && l.session >= 0, RambuError::BadPayload);
            return Ok(l);
        }
    }
    err!(RambuError::FeedMismatch)
}

/// Token-2022 ScaledUiAmount multiplier at `now` (1.0 if the mint has no such extension).
pub fn scaled_multiplier(d: &[u8], now: i64) -> Result<f64> {
    require!(d.len() >= 82, RambuError::BadMint);
    if d.len() <= 165 {
        return Ok(1.0);
    }
    require!(d[165] == 1, RambuError::BadMint); // AccountType::Mint
    let mut o = 166;
    while o + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[o], d[o + 1]]);
        let len = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
        let v = d.get(o + 4..o + 4 + len).ok_or(error!(RambuError::BadMint))?;
        if ty == 25 {
            require!(len >= 56, RambuError::BadMint);
            let f = |i: usize| f64::from_le_bytes(v[i..i + 8].try_into().unwrap());
            let ts = i64::from_le_bytes(v[40..48].try_into().unwrap());
            let m = if now >= ts { f(48) } else { f(32) };
            require!(m.is_finite() && m > 0.0, RambuError::BadMint);
            return Ok(m);
        }
        if ty == 0 {
            break;
        }
        o += 4 + len;
    }
    Ok(1.0)
}

/// Raw-token price in e6 from a verified Pyth payload, after Pyth-side freshness, session and confidence rules.
pub fn verified_price(p: &Lazer, s: &StockState, now: i64, mult: f64, flags: u8, max_age_s: u32, max_band_bps: u16) -> Result<u64> {
    let age = tighter(s.max_age_s, max_age_s) as i64;
    require!(p.price > 0, RambuError::PriceRequired);
    require!(now.saturating_sub((p.timestamp_us / 1_000_000) as i64) <= age, RambuError::Stale);
    // while regular hours run, the feed itself must be ticking; outside them the last print is the price
    if p.session == 0 {
        require!(now.saturating_sub((p.feed_update_us / 1_000_000) as i64) <= age, RambuError::Stale);
    }
    require!(flags & REQUIRE_REGULAR_SESSION == 0 || p.session == 0, RambuError::SessionClosed);
    // a confidence wider than the band can't prove the price is inside it
    require!(p.conf as i128 * 10_000 <= p.price as i128 * tighter(s.band_bps, max_band_bps) as i128, RambuError::OutsideBand);
    let e = 6 + p.expo as i32;
    require!((-18..=18).contains(&e), RambuError::BadPayload);
    let base = if e >= 0 { p.price as f64 * 10f64.powi(e) } else { p.price as f64 / 10f64.powi(-e) };
    let v = (base * mult).round();
    require!(v >= 1.0 && v < u64::MAX as f64, RambuError::PriceRequired);
    Ok(v as u64)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpsertArgs {
    pub ticker: [u8; 12],
    pub session: u8,
    pub halt: u8,
    pub halt_code: [u8; 4],
    pub halted_at: i64,
    pub resume_at: i64,
    pub event: u8,
    pub event_ref: [u8; 20], // SEC accession number, e.g. 0001045810-26-000078
    pub ref_price_e6: u64,
    pub band_bps: u16,
    pub max_age_s: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub authority: Pubkey,
    pub keeper: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StockState {
    pub mint: Pubkey,
    pub ticker: [u8; 12],
    pub session: u8,
    pub halt: u8,
    pub halt_code: [u8; 4],
    pub halted_at: i64,
    pub resume_at: i64,
    pub event: u8,
    pub event_ref: [u8; 20],
    pub ref_price_e6: u64,
    pub band_bps: u16,
    pub max_age_s: u32,
    pub updated_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FeedLink {
    pub mint: Pubkey,
    pub feed_id: u32,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(init, payer = authority, space = 8 + Registry::INIT_SPACE, seeds = [b"registry"], bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::Rambu>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()))]
    pub program_data: Account<'info, ProgramData>,
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    #[account(mut, seeds = [b"registry"], bump = registry.bump, has_one = authority)]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct SetFeed<'info> {
    #[account(seeds = [b"registry"], bump = registry.bump, has_one = authority)]
    pub registry: Account<'info, Registry>,
    #[account(init_if_needed, payer = authority, space = 8 + FeedLink::INIT_SPACE, seeds = [b"feed", mint.as_ref()], bump)]
    pub feed: Account<'info, FeedLink>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Upsert<'info> {
    #[account(seeds = [b"registry"], bump = registry.bump, has_one = keeper)]
    pub registry: Account<'info, Registry>,
    #[account(init_if_needed, payer = keeper, space = 8 + StockState::INIT_SPACE, seeds = [b"rambu", mint.key().as_ref()], bump)]
    pub state: Account<'info, StockState>,
    /// CHECK: only used as PDA seed; xStocks mints are Token-2022 and may not exist on devnet
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AssertTradable<'info> {
    #[account(seeds = [b"rambu", state.mint.as_ref()], bump = state.bump)]
    pub state: Account<'info, StockState>,
}

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct AssertTradableV2<'info> {
    #[account(seeds = [b"rambu", mint.as_ref()], bump = state.bump)]
    pub state: Account<'info, StockState>,
}

#[derive(Accounts)]
pub struct AssertTradableVerified<'info> {
    #[account(seeds = [b"rambu", mint.key().as_ref()], bump = state.bump)]
    pub state: Account<'info, StockState>,
    #[account(seeds = [b"feed", mint.key().as_ref()], bump = feed.bump)]
    pub feed: Account<'info, FeedLink>,
    /// CHECK: the xStock mint; must be a Token-2022 account, its ScaledUiAmount multiplier is read here
    #[account(owner = TOKEN_2022 @ RambuError::BadMint)]
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Pyth Lazer program
    #[account(address = PYTH_LAZER)]
    pub pyth_program: UncheckedAccount<'info>,
    /// CHECK: Pyth Lazer storage (trusted signers), checked by Pyth
    #[account(address = PYTH_STORAGE)]
    pub pyth_storage: UncheckedAccount<'info>,
    /// CHECK: Pyth Lazer treasury, has_one-checked by Pyth against storage
    #[account(mut)]
    pub pyth_treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: instructions sysvar
    #[account(address = IX_SYSVAR)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct StateChanged {
    pub mint: Pubkey,
    pub halt: u8,
    pub event: u8,
    pub session: u8,
    pub ref_price_e6: u64,
    pub prev_ref_e6: u64,
    pub band_bps: u16,
    pub max_age_s: u32,
    pub halt_code: [u8; 4],
    pub event_ref: [u8; 20],
    pub updated_at: i64,
}

#[event]
pub struct Heartbeat {
    pub mint: Pubkey,
    pub updated_at: i64,
}

#[event]
pub struct VerifiedPrice {
    pub mint: Pubkey,
    pub feed_id: u32,
    pub price_e6: u64,
    pub publish_us: u64,
    pub market_session: i16,
}

// Append only: integrators match on 6000 + index.
#[error_code]
pub enum RambuError {
    #[msg("Rambu state is stale")]
    Stale,
    #[msg("Trading halted")]
    Halted,
    #[msg("Volatility pause in effect")]
    Paused,
    #[msg("Corporate event pending")]
    EventPending,
    #[msg("Price outside band")]
    OutsideBand,
    #[msg("Upsert parameter out of range")]
    BadParam,
    #[msg("Lender check needs a nonzero price")]
    PriceRequired,
    #[msg("No reference price onchain")]
    NoReference,
    #[msg("Not in the regular trading session")]
    SessionClosed,
    #[msg("Malformed Pyth Lazer payload")]
    BadPayload,
    #[msg("Payload does not carry the feed linked to this mint")]
    FeedMismatch,
    #[msg("Mint account is not a readable Token-2022 mint")]
    BadMint,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st() -> StockState {
        StockState {
            mint: Pubkey::default(), ticker: [0; 12], session: 2, halt: HALT_NONE, halt_code: [0; 4],
            halted_at: 0, resume_at: 0, event: 0, event_ref: [0; 20],
            ref_price_e6: 100_000_000, band_bps: 500, max_age_s: 300, updated_at: 1_000, bump: 0,
        }
    }
    const NOW: i64 = 1_100;
    fn code(r: Result<()>) -> u32 {
        match r { Err(Error::AnchorError(e)) => e.error_code_number, Ok(()) => 0, Err(e) => panic!("{e:?}") }
    }
    const E: u32 = 6000;

    #[test]
    fn rules() {
        assert!(check(&st(), NOW, 104_000_000, false).is_ok());
        assert_eq!(code(check(&st(), NOW, 106_000_000, false)), E + 4); // > 5% band
        assert_eq!(code(check(&st(), NOW, 0, false)), E + 6); // lender without price: PriceRequired
        assert!(check(&st(), NOW, 0, true).is_ok()); // swap path skips the band
        assert_eq!(code(check(&st(), 2_000, 0, true)), E); // stale

        let mut h = st(); h.halt = HALT_HARD;
        assert_eq!(code(check(&h, NOW, 100_000_000, false)), E + 1);
        for halt in [HALT_ISSUER, 4, 77, 255] { h.halt = halt; assert_eq!(code(check(&h, NOW, 100_000_000, false)), E + 1); }

        let mut p = st(); p.halt = HALT_SOFT; p.resume_at = 1_200;
        assert_eq!(code(check(&p, NOW, 100_000_000, false)), E + 2);
        assert!(check(&p, 1_250, 100_000_000, false).is_ok());
        p.resume_at = 0; // SOFT without resume time never resumes
        assert_eq!(code(check(&p, 9_999_999, 100_000_000, true)), E);
        p.updated_at = 9_999_000;
        assert_eq!(code(check(&p, 9_999_100, 100_000_000, true)), E + 2);

        let mut e = st(); e.event = 1;
        assert_eq!(code(check(&e, NOW, 100_000_000, false)), E + 3);
        assert!(check(&e, NOW, 0, true).is_ok());

        let mut z = st(); z.ref_price_e6 = 0;
        assert_eq!(code(check(&z, NOW, 100_000_000, false)), E + 7); // NoReference
    }

    #[test]
    fn edges() {
        // max_age boundary: age == max passes, +1 fails
        assert!(check(&st(), 1_300, 100_000_000, false).is_ok());
        assert_eq!(code(check(&st(), 1_301, 100_000_000, false)), E);
        // band exactly at the edge passes, one unit past fails
        assert!(check(&st(), NOW, 105_000_000, false).is_ok());
        assert!(check(&st(), NOW, 95_000_000, false).is_ok());
        assert_eq!(code(check(&st(), NOW, 105_000_001, false)), E + 4);
        assert_eq!(code(check(&st(), NOW, 94_999_999, false)), E + 4);
    }

    #[test]
    fn v2_limits_and_session() {
        let s = st();
        // lender can tighten: band 200bps, age 60s
        assert!(check_with(&s, NOW, 104_000_000, 0, 0, 0).is_ok());
        assert_eq!(code(check_with(&s, NOW, 104_000_000, 0, 0, 200)), E + 4);
        assert!(check_with(&s, NOW, 102_000_000, 0, 0, 200).is_ok());
        assert_eq!(code(check_with(&s, NOW, 102_000_000, 0, 60, 0)), E);
        // ...but never loosen: 9000bps / 1 day still capped by state (500bps / 300s)
        assert_eq!(code(check_with(&s, NOW, 106_000_000, 0, 0, 9_000)), E + 4);
        assert_eq!(code(check_with(&s, 1_400, 100_000_000, 0, 86_400, 0)), E);
        // session flag
        let mut c = st(); c.session = 5;
        assert!(check_with(&c, NOW, 100_000_000, 0, 0, 0).is_ok());
        assert_eq!(code(check_with(&c, NOW, 100_000_000, REQUIRE_REGULAR_SESSION, 0, 0)), E + 8);
        assert!(check_with(&s, NOW, 100_000_000, REQUIRE_REGULAR_SESSION, 0, 0).is_ok());
        let mut e = st(); e.event = 2;
        assert!(check_with(&e, NOW, 100_000_000, IGNORE_EVENTS, 0, 0).is_ok());
        assert_eq!(code(check_with(&e, NOW, 100_000_000, 0, 0, 0)), E + 3);
    }

    #[test]
    fn get_price_rules() {
        assert_eq!(price_of(&st(), NOW).unwrap(), (100_000_000, -6, 1_000));
        let mut h = st(); h.halt = HALT_ISSUER;
        assert!(price_of(&h, NOW).is_err());
        let mut z = st(); z.ref_price_e6 = 0;
        assert!(price_of(&z, NOW).is_err());
        assert!(price_of(&st(), 5_000).is_err());
    }

    fn args() -> UpsertArgs {
        UpsertArgs { ticker: [0; 12], session: 2, halt: 0, halt_code: [0; 4], halted_at: 0, resume_at: 0, event: 0, event_ref: [0; 20], ref_price_e6: 1, band_bps: 1000, max_age_s: 900 }
    }

    #[test]
    fn validate_bounds() {
        let ok = |f: fn(&mut UpsertArgs)| { let mut a = args(); f(&mut a); validate(&a).is_ok() };
        assert!(ok(|_| {}));
        assert!(ok(|a| a.band_bps = 10) && ok(|a| a.band_bps = 2000));
        assert!(!ok(|a| a.band_bps = 9) && !ok(|a| a.band_bps = 2001) && !ok(|a| a.band_bps = 0));
        assert!(ok(|a| a.max_age_s = 60) && ok(|a| a.max_age_s = 3600));
        assert!(!ok(|a| a.max_age_s = 59) && !ok(|a| a.max_age_s = 3601));
        assert!(ok(|a| a.halt = HALT_ISSUER) && !ok(|a| a.halt = 4));
        assert!(ok(|a| a.session = 5) && !ok(|a| a.session = 6));
        assert!(!ok(|a| a.halt = HALT_SOFT));
        assert!(ok(|a| { a.halt = HALT_SOFT; a.resume_at = 1 }));
        let mut a = args(); a.band_bps = 0;
        assert_eq!(code(validate(&a)), E + 5);
    }

    // Real signed Pyth Pro message, feed 1363 (QQQ), fetched 2026-09-19 from /v1/latest_price with formats ["solana"],
    // properties price, exponent, confidence, marketSession, feedUpdateTimestamp. Public signed data.
    const QQQ: &str = "b9011a82b90fe5afec5b3b1500c0a8798c644aea608d1138c45c022d7f8ceccd913fd4afd7698fbb20d96a0d221c8e3fedc71fc024227d7d1692d3439e19eefa9509a60680efc1f480c5615af3fb673d42287e993da9fbc3506b6e41dfa32950820c2e6c350075d3c793401db388d75b06000301530500000500e7c84d040000000004fbff0520450000000000000904000c01b05cb4b2ca5b0600";
    fn hex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() }

    #[test]
    fn lazer_payload() {
        let m = hex(QQQ);
        let p = parse_lazer(&m, 1363).unwrap();
        assert_eq!(p, Lazer { timestamp_us: 1789831129800000, feed_id: 1363, price: 72206567, expo: -5, conf: 17696, session: 4, feed_update_us: 1789775999950000 });
        assert_eq!(code(parse_lazer(&m, 1435).map(|_| ())), E + 10); // TSLA not in this payload
        assert!(parse_lazer(&m[..m.len() - 1], 1363).is_err());
        let mut bad = m.clone(); bad[0] ^= 1;
        assert!(parse_lazer(&bad, 1363).is_err());

        // 722.06567 × 1.0 → 722065670 e6; conf 0.18 ≪ 2% band
        let mut s = st(); s.ref_price_e6 = 722_000_000; s.max_age_s = 300;
        let now = 1789831129 + 10;
        assert_eq!(verified_price(&p, &s, now, 1.0, 0, 0, 0).unwrap(), 722_065_670);
        assert_eq!(verified_price(&p, &s, now, 1.0057, 0, 0, 0).unwrap(), 726_181_444);
        assert_eq!(code(verified_price(&p, &s, now, 1.0, REQUIRE_REGULAR_SESSION, 0, 0).map(|_| ())), E + 8); // closed
        assert_eq!(code(verified_price(&p, &s, now + 300, 1.0, 0, 0, 0).map(|_| ())), E); // stale attestation
        assert_eq!(code(verified_price(&p, &s, now, 1.0, 0, 0, 2).map(|_| ())), E + 4); // conf 2.45bp > 0.02% band
        let mut open = Lazer { session: 0, ..p };
        assert_eq!(code(verified_price(&open, &s, now, 1.0, 0, 0, 0).map(|_| ())), E); // regular hours, feed not ticking
        open.feed_update_us = open.timestamp_us;
        assert!(verified_price(&open, &s, now, 1.0, REQUIRE_REGULAR_SESSION, 0, 0).is_ok());
    }

    #[test]
    fn multiplier() {
        let mut d = vec![0u8; 166 + 4 + 56];
        d[165] = 1;
        d[166..168].copy_from_slice(&25u16.to_le_bytes());
        d[168..170].copy_from_slice(&56u16.to_le_bytes());
        d[170 + 32..170 + 40].copy_from_slice(&1.005714f64.to_le_bytes());
        d[170 + 40..170 + 48].copy_from_slice(&2_000i64.to_le_bytes());
        d[170 + 48..170 + 56].copy_from_slice(&1.008f64.to_le_bytes());
        assert_eq!(scaled_multiplier(&d, 1_999).unwrap(), 1.005714);
        assert_eq!(scaled_multiplier(&d, 2_000).unwrap(), 1.008);
        assert_eq!(scaled_multiplier(&d[..82], 0).unwrap(), 1.0);
        assert!(scaled_multiplier(&d[..50], 0).is_err());
    }
}
