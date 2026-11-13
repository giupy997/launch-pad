#!/bin/bash
# Holder cashback that nobody came for: who is owed what on a coin, and, on a
# pad that has claimCashbackFor, the push that sends it to them. Cashback is
# claimed by its holder (claimCashback, the button on the coin's page) and
# waits in the pad without a term; most holders never come. claimCashbackFor
# pays a list of wallets what each could claim, to the holder alone, called
# by anyone: this is the command to run once a week.
#
#   bash script/ops/cashback.sh <coin>           # the report: what waits and for whom, no transaction (any pad)
#   bash script/ops/cashback.sh <coin> --push    # the report, then claimCashbackFor in batches, after a yes
#
# The Base v12 pad has no claimCashbackFor and cannot be given one (its module
# is fixed): there the report is all there is, and holders claim for
# themselves. --push says so and stops.
#
# MIN=0.001 leaves the wallets owed less than that much quote out of the push
# (default 0: everyone); BATCH is the wallets a transaction (default 100);
# FROM_BLOCK starts the scan of the coin's transfers later than the pad's
# deploy block (PAD_BLOCK in the addresses file), for a coin launched long
# after it. Contracts are never in the list: the pad passes them over, and a
# push into a pool or a locker would go where its holders did not mean it to.
# A wallet that delegated (EIP-7702) is a wallet, and is paid.
#
# The pad comes from ADDRESSES (default verify/base-v12/addresses.sh), the
# node from BASE_RPC or SRC_RPC in .env (else foundry's `base`), the signer
# from the keystore ACCOUNT (default `notus`; PRIVATE_KEY for a test key on a
# test network). The report needs node and web/node_modules (npm ci in web/).
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
# shellcheck disable=SC1091
source "${ADDRESSES:-verify/base-v12/addresses.sh}"
TOKEN=${1:-}
MODE=${2:-report}
case "$TOKEN" in 0x????????????????????????????????????????) ;; *) sed -n '2,27p' "$0"; exit 1 ;; esac
case "$MODE" in report | --push) ;; *) sed -n '2,27p' "$0"; exit 1 ;; esac
RPC=${BASE_RPC:-${SRC_RPC:-}}
RPC=${RPC%%,*}
RPC=${RPC:-base}
export ETH_RPC_URL=$RPC # cast reads it from here: the (keyed) URL stays off every command line
CHAIN=$(cast chain-id 2>/dev/null || echo "?")
[ "$CHAIN" = "${CHAIN_ID:-8453}" ] || { echo "the node answers for chain $CHAIN; this addresses file is for chain ${CHAIN_ID:-8453}"; exit 1; }
FROM=${FROM_BLOCK:-${PAD_BLOCK:-}}
[ -n "$FROM" ] || { echo "no block to scan from: PAD_BLOCK in the addresses file, or FROM_BLOCK in the environment"; exit 1; }
# the report reads through the same node: its URL goes to node in the environment, never on a command line
case "$RPC" in http*) NODE_RPC=$RPC ;; *) NODE_RPC=$(forge config --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).rpc_endpoints[process.argv[1]]||"")}catch{console.log("")}})' "$RPC") ;; esac
[ -n "${NODE_RPC:-}" ] || { echo "no node URL: BASE_RPC or SRC_RPC in .env"; exit 1; }

LIST=$(mktemp "${TMPDIR:-/tmp}/notus-cashback.XXXXXX") || exit 1
trap 'rm -rf "$LIST" "${PWDIR:-}"' EXIT INT TERM
SRC_RPC=$NODE_RPC node script/cashback.mjs --launchpad "$PAD" --token "$TOKEN" --from-block "$FROM" --min "${MIN:-0}" --out "$LIST" || exit 1
[ "$MODE" = "--push" ] || exit 0

# a pad without the function reverts on its selector (the module has none): nothing to send
if ! cast call "$PAD" "claimCashbackFor(address,address[])(uint256)" "$TOKEN" "[]" >/dev/null 2>&1; then
  echo "   this pad ($PAD) has no claimCashbackFor: its holders claim for themselves (claimCashback, the coin's page)"
  exit 1
fi
N=$(grep -c . "$LIST" || true)
[ "$N" -gt 0 ] || { echo "   nobody to pay"; exit 0; }
BATCH=${BATCH:-100}
read -rp "   send claimCashbackFor for $N wallets, $BATCH a transaction? (yes) " OK
[ "$OK" = "yes" ] || { echo "   nothing sent"; exit 0; }

if [ -n "${PRIVATE_KEY:-}" ]; then
  # a test key from the environment signs on a test network only: on a live chain the keystore does
  case "$CHAIN" in 1 | 8453) [ "${ALLOW_PRIVATE_KEY:-}" = 1 ] || { echo "PRIVATE_KEY is set in the environment: on chain $CHAIN the keystore signs (unset it, or ALLOW_PRIVATE_KEY=1 to sign with it anyway)"; exit 1; } ;; esac
  SIGNER=(--private-key "$PRIVATE_KEY")
else
  # asked once: the password goes to cast through a file (never a command line, which every
  # process on the machine can read), readable by this user alone, gone when the script ends
  PWDIR=$(mktemp -d "${TMPDIR_SECRET:-/dev/shm}/notus-cashback.XXXXXX") || { echo "   no private directory for the keystore password"; exit 1; }
  chmod 700 "$PWDIR"
  read -rsp "   password of the keystore ${ACCOUNT:-notus} (asked once, kept for every send): " PW; echo
  (umask 077; printf '%s' "$PW" > "$PWDIR/password")
  unset PW
  SIGNER=(--account "${ACCOUNT:-notus}" --password-file "$PWDIR/password")
  SIGNER_ADDR=$(cast wallet address "${SIGNER[@]}" 2>/dev/null) || { echo "   the keystore ${ACCOUNT:-notus} did not open: wrong password, or no such account in ~/.foundry/keystores"; exit 1; }
  echo "   signer: $SIGNER_ADDR (keystore ${ACCOUNT:-notus})"
fi

# the outcome of a send from its receipt: its hash when it was mined and succeeded
outcome() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("{");if(i<0){console.log("not sent");return}const r=JSON.parse(s.slice(i,s.lastIndexOf("}")+1));console.log(r.status==="0x1"||r.status===1||r.status==="success"?"paid "+r.transactionHash:"reverted "+r.transactionHash)})'; }
SENT=0
FAILED=0
while [ "$SENT" -lt "$N" ]; do
  HOLDERS=$(sed -n "$((SENT + 1)),$((SENT + BATCH))p" "$LIST" | paste -sd, -)
  COUNT=$(sed -n "$((SENT + 1)),$((SENT + BATCH))p" "$LIST" | grep -c .)
  # what the batch would pay, read before it is sent: the quote's smallest units
  WOULD=$(cast call "$PAD" "claimCashbackFor(address,address[])(uint256)" "$TOKEN" "[$HOLDERS]" 2>/dev/null | awk '{print $1}')
  RESULT=$(cast send "$PAD" "claimCashbackFor(address,address[])" "$TOKEN" "[$HOLDERS]" "${SIGNER[@]}" --json 2>/dev/null | outcome)
  case "$RESULT" in
    paid*) echo "   wallets $((SENT + 1))-$((SENT + COUNT)): ${WOULD:-?} units of quote sent, ${RESULT#paid }";;
    *) echo "   wallets $((SENT + 1))-$((SENT + COUNT)): NOT paid ($RESULT): their claims are untouched"; FAILED=1;;
  esac
  SENT=$((SENT + COUNT))
done
[ "$FAILED" = 0 ] && echo "   done: run the report again to see what is left (contracts, and wallets the quote asset refuses)"
exit "$FAILED"
