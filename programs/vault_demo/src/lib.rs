// Stand-in for a lending market: liquidations only go through if Rambu says the stock is tradable.
use anchor_lang::prelude::*;
use rambu::cpi::accounts::AssertTradable;
use rambu::program::Rambu;
use rambu::StockState;

declare_id!("EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz");

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

    pub fn liquidate(ctx: Context<Liquidate>, price_e6: u64) -> Result<()> {
        // lenders never ignore pending corporate events
        rambu::cpi::assert_tradable(
            CpiContext::new(ctx.accounts.rambu_program.key(), AssertTradable { state: ctx.accounts.state.to_account_info() }),
            price_e6,
            false,
        )?;
        ctx.accounts.position.liquidated = true;
        emit!(Liquidated { position: ctx.accounts.position.key(), price_e6 });
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
    #[account(mut, constraint = position.mint == state.mint)]
    pub position: Account<'info, Position>,
    pub state: Account<'info, StockState>,
    pub rambu_program: Program<'info, Rambu>,
    pub liquidator: Signer<'info>,
}

#[event]
pub struct Liquidated {
    pub position: Pubkey,
    pub price_e6: u64,
}
