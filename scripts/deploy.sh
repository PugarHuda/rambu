#!/usr/bin/env bash
# Build + deploy both programs to devnet, then wire program IDs into web and keeper. Run inside WSL.
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

cargo build-sbf --manifest-path programs/rambu/Cargo.toml --sbf-out-dir target/deploy
cargo build-sbf --manifest-path programs/vault_demo/Cargo.toml --sbf-out-dir target/deploy

echo "deployer $DEPLOYER balance: $(solana balance -u devnet "$DEPLOYER")"
solana program deploy -u devnet -k keys/deployer.json --program-id keys/rambu.json target/deploy/rambu.so
solana program deploy -u devnet -k keys/deployer.json --program-id keys/vault_demo.json target/deploy/vault_demo.so

sed -i "s/const PROGRAM_ID = \"[^\"]*\"/const PROGRAM_ID = \"$RAMBU\"/" web/index.html
printf 'RAMBU_PROGRAM_ID=%s\nVAULT_PROGRAM_ID=%s\nKEEPER_KEYPAIR=../keys/deployer.json\n' "$RAMBU" "$VAULT" > keeper/.env
echo "rambu=$RAMBU vault_demo=$VAULT"
