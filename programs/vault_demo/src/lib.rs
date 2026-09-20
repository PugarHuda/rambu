// Stand-in for a lending market: liquidations only go through if Rambu says the stock is tradable.
use anchor_lang::prelude::*;
use rambu::cpi::accounts::{AssertTradableV2, AssertTradableVerified};
use rambu::program::Rambu;
use rambu::{FeedLink, StockState, REQUIRE_REGULAR_SESSION};

declare_id!("EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz");

// this lender's own limits, tighter than the keeper's defaults
const MAX_AGE_S: u32 = 300;
const MAX_BAND_BPS: u16 = 200;

#[program]
pub mod vault_demo {
    use super::*;

    pub fn open_position(ctx: Context<OpenPosition>, mint: Pubkey) -> Result<()> {
        let p = &mut ctx.accounts.position;
        p.owner = ctx.accounts.owner.key();
        p.mint = mint;
        p.liquidated = false;
        Ok(())
    }

    /// price_e6 is an argument only because this is a demo: a real lender passes its own oracle read here, never
    /// a number the liquidator chose. liquidate_verified below is that path.
    pub fn liquidate(ctx: Context<Liquidate>, price_e6: u64) -> Result<()> {
        require!(price_e6 > 0, VaultError::PriceRequired);
        let mint = ctx.accounts.position.mint;
        // lenders never ignore pending corporate events
        rambu::cpi::assert_tradable_v2(
            CpiContext::new(ctx.accounts.rambu_program.key(), AssertTradableV2 { state: ctx.accounts.state.to_account_info() }),
            mint, price_e6, REQUIRE_REGULAR_SESSION, MAX_AGE_S, MAX_BAND_BPS,
        )?;
        ctx.accounts.position.liquidated = true;
        emit!(Liquidated { position: ctx.accounts.position.key(), price_e6, verified: false });
        Ok(())
    }

    /// Liquidates at a Pyth Pro price verified in this transaction. `message` must stay the first arg: the Ed25519 ix
    /// points at offset 12 of this instruction's data, which is where Pyth Lazer looks for it.
    pub fn liquidate_verified(ctx: Context<LiquidateVerified>, message: Vec<u8>, ed25519_ix_index: u16) -> Result<()> {
        let a = &ctx.accounts;
        rambu::cpi::assert_tradable_verified(
            CpiContext::new(a.rambu_program.key(), AssertTradableVerified {
                state: a.state.to_account_info(),
                feed: a.feed.to_account_info(),
                mint: a.mint.to_account_info(),
                payer: a.liquidator.to_account_info(),
                pyth_program: a.pyth_program.to_account_info(),
                pyth_storage: a.pyth_storage.to_account_info(),
                pyth_treasury: a.pyth_treasury.to_account_info(),
                system_program: a.system_program.to_account_info(),
                instructions_sysvar: a.instructions_sysvar.to_account_info(),
            }),
            message, ed25519_ix_index, REQUIRE_REGULAR_SESSION, MAX_AGE_S, MAX_BAND_BPS,
        )?;
        ctx.accounts.position.liquidated = true;
        emit!(Liquidated { position: ctx.accounts.position.key(), price_e6: 0, verified: true });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub liquidated: bool,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(init, payer = owner, space = 8 + Position::INIT_SPACE)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut, constraint = position.mint == state.mint, constraint = !position.liquidated @ VaultError::AlreadyLiquidated)]
    pub position: Account<'info, Position>,
    pub state: Account<'info, StockState>,
    pub rambu_program: Program<'info, Rambu>,
    pub liquidator: Signer<'info>,
}

#[derive(Accounts)]
pub struct LiquidateVerified<'info> {
    #[account(mut, constraint = position.mint == state.mint, constraint = position.mint == mint.key(), constraint = !position.liquidated @ VaultError::AlreadyLiquidated)]
    pub position: Account<'info, Position>,
    pub state: Account<'info, StockState>,
    pub feed: Account<'info, FeedLink>,
    /// CHECK: checked by rambu (Token-2022 owner, PDA seed)
    pub mint: UncheckedAccount<'info>,
    pub rambu_program: Program<'info, Rambu>,
    #[account(mut)]
    pub liquidator: Signer<'info>,
    /// CHECK: checked by rambu
    pub pyth_program: UncheckedAccount<'info>,
    /// CHECK: checked by rambu / Pyth
    pub pyth_storage: UncheckedAccount<'info>,
    /// CHECK: checked by Pyth
    #[account(mut)]
    pub pyth_treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: checked by rambu
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct Liquidated {
    pub position: Pubkey,
    pub price_e6: u64,
    pub verified: bool,
}

#[error_code]
pub enum VaultError {
    #[msg("Liquidation needs a nonzero price")]
    PriceRequired,
    #[msg("Position already liquidated")]
    AlreadyLiquidated,
}
