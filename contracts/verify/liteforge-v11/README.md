# Liteforge v11 rehearsal pad: verification

Standard JSON inputs of the Launchpad, the UniV2Migrator and the LaunchToken
(`node script/standard-input.mjs` from the commit that deployed them) and
`verify-blockscout.sh`, which submits them to the Caldera Blockscout through
its v2 API and waits for the result. forge's own `verify-contract --verifier
blockscout` works against the same explorer when it is healthy (the command
is in `script/DeployLitVM.s.sol`); this is the fallback.

Both the Launchpad and the UniV2Migrator were verified this way on 2026-10-06,
once the explorer had caught up: for two days after the deploy it answered
"not a smart-contract" for the pad, which the script now diagnoses before it
submits anything.
