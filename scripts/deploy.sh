#!/usr/bin/env bash
# Build + deploy (or upgrade, same program ids) both programs to devnet, then init the registry and the Pyth Pro mirrors.
# Run inside WSL. Never prints key contents.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."

mkdir -p keys
for k in deployer rambu vault_demo; do
  [ -f "keys/$k.json" ] || solana-keygen new --no-bip39-passphrase -s -o "keys/$k.json" >/dev/null
done
RAMBU=$(solana-keygen pubkey keys/rambu.json)
VAULT=$(solana-keygen pubkey keys/vault_demo.json)
DEPLOYER=$(solana-keygen pubkey keys/deployer.json)

sed -i "s/declare_id!(\"[^\"]*\")/declare_id!(\"$RAMBU\")/" programs/rambu/src/lib.rs
sed -i "s/declare_id!(\"[^\"]*\")/declare_id!(\"$VAULT\")/" programs/vault_demo/src/lib.rs

CARGO_TARGET_DIR=/tmp/rambu-target cargo test -p rambu --lib
cargo build-sbf --manifest-path programs/rambu/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --manifest-path programs/vault_demo/Cargo.toml --sbf-out-dir target/deploy

echo "deployer $DEPLOYER balance: $(solana balance -u devnet "$DEPLOYER")"
# first deploy uses the program keypair; later runs upgrade in place with the deployer as upgrade authority
solana program deploy -u devnet -k keys/deployer.json --upgrade-authority keys/deployer.json --program-id keys/rambu.json target/deploy/rambu.so
solana program deploy -u devnet -k keys/deployer.json --upgrade-authority keys/deployer.json --program-id keys/vault_demo.json target/deploy/vault_demo.so

sed -i "s/const PROGRAM_ID = \"[^\"]*\"/const PROGRAM_ID = \"$RAMBU\"/" web/index.html
# keep SEC_UA / PYTH_PRO_TOKEN / TRACK already in keeper/.env; only (re)write the ids
touch keeper/.env
sed -i '/^RAMBU_PROGRAM_ID=\|^VAULT_PROGRAM_ID=\|^KEEPER_KEYPAIR=/d' keeper/.env
printf 'RAMBU_PROGRAM_ID=%s\nVAULT_PROGRAM_ID=%s\nKEEPER_KEYPAIR=../keys/deployer.json\n' "$RAMBU" "$VAULT" >> keeper/.env

# registry (gated on the upgrade authority), then devnet mirrors of the Pyth Pro entitled xStocks + feed links
cd keeper
NODE=$(command -v node || command -v node.exe) # WSL without node: Windows node via interop
export NODE_OPTIONS="--dns-result-order=ipv4first --no-warnings" WSLENV="NODE_OPTIONS${WSLENV:+:$WSLENV}"
"$NODE" --env-file=.env admin.ts --init
"$NODE" --env-file=.env admin.ts --mirror QQQx
"$NODE" --env-file=.env admin.ts --mirror TSLAx
echo "rambu=$RAMBU vault_demo=$VAULT"
