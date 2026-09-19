use anchor_lang::prelude::*;

declare_id!("5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm");

pub const HALT_NONE: u8 = 0;
pub const HALT_HARD: u8 = 1;
pub const HALT_SOFT: u8 = 2;
pub const HALT_ISSUER: u8 = 3;

#[program]
pub mod rambu {
    use super::*;

    pub fn init_registry(ctx: Context<InitRegistry>, keeper: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.authority = ctx.accounts.authority.key();
        r.keeper = keeper;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn set_keeper(ctx: Context<SetKeeper>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.registry.keeper = keeper;
        Ok(())
    }

    // ponytail: single trusted keeper; quorum of keepers / CRE workflow is the upgrade path
    pub fn upsert(ctx: Context<Upsert>, a: UpsertArgs) -> Result<()> {
        let s = &mut ctx.accounts.state;
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
        emit!(StateChanged { mint: s.mint, halt: s.halt, event: s.event, session: s.session });
        Ok(())
    }

    /// Fails the whole transaction if the stock should not trade right now.
    /// price_e6 = 0 skips the band check; ignore_events lets swaps proceed while lenders still block.
    pub fn assert_tradable(ctx: Context<AssertTradable>, price_e6: u64, ignore_events: bool) -> Result<()> {
        check(&ctx.accounts.state, Clock::get()?.unix_timestamp, price_e6, ignore_events)
    }
}

pub fn check(s: &StockState, now: i64, price_e6: u64, ignore_events: bool) -> Result<()> {
    require!(now.saturating_sub(s.updated_at) <= s.max_age_s as i64, RambuError::Stale);
    match s.halt {
        HALT_NONE => {}
        HALT_SOFT => require!(s.resume_at != 0 && now >= s.resume_at, RambuError::Paused),
        _ => return err!(RambuError::Halted),
    }
    require!(ignore_events || s.event == 0, RambuError::EventPending);
    if s.ref_price_e6 > 0 && price_e6 > 0 {
        let diff = (price_e6 as i128 - s.ref_price_e6 as i128).unsigned_abs();
        require!(diff * 10_000 <= s.ref_price_e6 as u128 * s.band_bps as u128, RambuError::OutsideBand);
    }
    Ok(())
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

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(init, payer = authority, space = 8 + Registry::INIT_SPACE, seeds = [b"registry"], bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetKeeper<'info> {
    #[account(mut, seeds = [b"registry"], bump = registry.bump, has_one = authority)]
    pub registry: Account<'info, Registry>,
    pub authority: Signer<'info>,
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

#[event]
pub struct StateChanged {
    pub mint: Pubkey,
    pub halt: u8,
    pub event: u8,
    pub session: u8,
}

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

    #[test]
    fn rules() {
        assert!(check(&st(), NOW, 104_000_000, false).is_ok());
        assert!(check(&st(), NOW, 106_000_000, false).is_err()); // > 5% band
        assert!(check(&st(), NOW, 0, false).is_ok()); // band skipped
        assert!(check(&st(), 2_000, 0, false).is_err()); // stale

        let mut h = st(); h.halt = HALT_HARD;
        assert!(check(&h, NOW, 0, false).is_err());
        h.halt = HALT_ISSUER;
        assert!(check(&h, NOW, 0, false).is_err());

        let mut p = st(); p.halt = HALT_SOFT; p.resume_at = 1_200;
        assert!(check(&p, NOW, 0, false).is_err());
        assert!(check(&p, 1_250, 0, false).is_ok());

        let mut e = st(); e.event = 1;
        assert!(check(&e, NOW, 0, false).is_err());
        assert!(check(&e, NOW, 0, true).is_ok());
    }
}
