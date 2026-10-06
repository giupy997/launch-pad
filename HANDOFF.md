# HANDOFF — Notus launchpad

Passaggio di consegne scritto il 2026-10-06 per riprendere il lavoro in una
sessione nuova, senza contesto. Il proprietario del progetto è giupy997
(GitHub `giupy997`), parla italiano; il sito, il README e i commit sono in
inglese. Tutto quello che segue è nel repository tranne i segreti, che non
sono mai stati scritti né in chat né nel repo e qui compaiono solo per nome.

Indice: 1 Obiettivo · 2 Stato · 3 Architettura · 4 Decisioni · 5 Configurazione
e comandi · 6 Problemi aperti · 7 Prossimi passi · 8 Cronologia · 9 Convenzioni
di lavoro.

---

## 1. Obiettivo del progetto

**Notus** è un token launchpad (modello pump.fun / Pons) per catene EVM:

- Chiunque crea una coin in una transazione; tutta la supply (1 miliardo) sta
  nel contratto `Launchpad`, che la vende lungo una **bonding curve** a
  riserve virtuali. A **800M coin vendute** la coin **gradua**: nella stessa
  transazione il resto della supply e la quota raccolta seminano una pool
  **Uniswap v2** con liquidità **bloccata**, aperta **al prezzo di chiusura
  della curva** (nessuno sconto, nessuna tassa anti-snipe, nessun tetto per
  wallet: scelte esplicite del proprietario).
- Oggi vive su **Base (chain 8453)** quotato in **cbLTC** (Litecoin wrappato
  da Coinbase, 8 decimali). Gli acquisti in ETH passano da uno zap su
  Aerodrome Slipstream (WETH → cbLTC) nella stessa transazione.
- Destinazione dichiarata: **LitVM mainnet**, l'L2 EVM di Litecoin (quote
  zkLTC). Quando LitVM va live, ogni coin di Base viene ricreata lì con gli
  stessi holder e lo stesso prezzo, pool inclusa (runbook in `MIGRATION.md`).
  La migrazione è stata **provata** sul testnet LitVM Liteforge (chain 4441).
- Con LitVM arrivano **punti e referral** (`POINTS.md`): la "Season 0" di
  prova gira già sul pad di Liteforge, servita da un servizio Node sulla VPS.
- Sito: **https://notus-pad.fun** (Netlify, deploy automatico da `main`).
  Repo: `github.com/giupy997/launch-pad` (rinominato; il remote locale può
  ancora dire `launchpadgiwa`, GitHub reindirizza). X: `@Notuspad`.
- Sezioni storiche nel repo: GIWA Sepolia (91342) e Robinhood Chain (4663, con
  64 quote asset RWA e un hook Uniswap v4) dei primi pad; **Notus on Litecoin**
  (ledger su OP_RETURN con un "desk" custodial) **chiuso**; **Zcash** (testnet)
  chiuso. Restano nel codice, non sono il lavoro corrente.

Perché: un launchpad trasparente e senza chiave di amministrazione (l'unico
proprietario del pad è un `TimelockController` a 24 ore), quotato in
Litecoin, che accompagni le coin verso LitVM.

---

## 2. Stato attuale (al 2026-10-06)

### Contratti su Base — stack **v11**, tutto verificato su Basescan

| Contratto | Indirizzo | Note |
|---|---|---|
| Launchpad v11 | `0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4` | deploy 2026-10-04, blocco 52.180.589, `script/DeployBase.s.sol` |
| LaunchTokenFactory | `0xac34DF8Cfb7Cd1d28441C5f17e294B07fb93EE4a` | |
| UniV2Migrator v2 | `0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218` | pool al prezzo di chiusura, mai scambia contro pool pre-seminate |
| SlipstreamZapRouter | `0x072a77dC2a770504A1DA17e2fB6814C9cFf85254` | ETH → cbLTC su Aerodrome, tick spacing 200 |
| TimelockController | `0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2` | unico owner del pad, delay 24 h |
| cbLTC (quote) | `0xcb17C9Db87B595717C857a08468793f5bAb6445F` | 8 decimali |
| Uniswap v2 Router02 (Base) | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | usato da PoolTrade |

Ruoli: deployer e proposer del timelock `0x707f56C25e5d8cc12d08A3bf73f54dBeD0CD9A02`;
treasury `0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7`.

Coin sul pad v11: **Notus** `0xc0DCC62B190ea0C9Ad6b115c5C9D36177256BeB6`
(creatore `0x7a30…753C`, la coin "definitiva" del progetto) e **LESTER**
`0x10046C37f06F9F2AC0c0852D5d9fCD02088ae927` (creatore `0x7122…E2F3`).

Pad ritirati su Base (tabella Deployments nel README): **v9**
`0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF` (le sue due pool sono state
svuotate da un exploit, vedi §4 e §8; **non lanciare nulla lì**) e **v10**
`0xDd48A36aa65142A5CF111f485C2EFB26482b74C1` (mai usato).

### Contratti su LitVM Liteforge (testnet, chain 4441) — pad di prova v11

- Launchpad `0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F`, blocco 57.741.789,
  riserva virtuale **0,05 zkLTC** (una curva gradua con 0,16 zkLTC, soldi da
  faucet), **owner = deployer** (è un pad di prova); UniV2Migrator v2
  `0xD45e4011Dae718aAF95DB5BdCA8e7Ee3ca8F413F` sul router Uniswap v2 di
  Lester Labs `0xD56a623890b083d876D47c3b1c5343b7f983FA62`.
- Coin **TEST** `0x179DECc1635C000fD2c257921d2b0f20c33a07f2` graduata dal vivo
  (pool `0x056681a339D682eC477c61776CeB98DcD4b86018`, 190,48M coin + 0,16
  zkLTC, 0% dal prezzo di chiusura, 9,52M bloccate nel pad). Un utente esterno
  ha graduato "likeey".
- Migrazione Base → Liteforge **provata** (`rehearse-liteforge.sh`, scala
  1:1000, ALL PASS): gemelle Notus `0x616e01ca4370433aE7690d0A5EF891ddbb553e99`
  e Lester `0x0d8144Ac2Fb62132786fe9671446e583385aaC09`. Il pad tiene quella
  radice di snapshot: la prossima prova vuole un pad nuovo (script senza
  `TARGET`).
- **Verifica su Blockscout (liteforge.explorer.caldera.xyz) ancora da fare**:
  l'explorer indicizza con ore di ritardo e rispondeva "not a smart-contract".
  Kit pronto: `contracts/verify/liteforge-v11/verify-blockscout.sh`.
- Timelock di Liteforge `0xFaFc00D9f9cD8A82874D05dFd17D6230dB320C87` (delay 10
  minuti) possiede i pad più vecchi lì; il v11 di prova no.

### Sito (web/) — tutto deployato su notus-pad.fun

Funziona: Explore con lista, mcap (in dollari dove la quote è LTC), volume
24h, holders; pagina coin con curva, grafico, feed, TradeBox (buy/sell, zap
ETH, approve una volta, 25/50/75/Max); **dopo la graduazione** la coin resta
comprabile dal sito tramite `PoolCard`/`PoolTrade` (router Uniswap v2) e feed,
grafico e volume includono gli swap della pool; Create con fee personalizzate;
Points e inviti (LitVM); Profile; Bridge/Get cbLTC; Swap; About; menu wallet
rifatto (pannello opaco, Switch wallet, Escape); cambio chain cbLTC ↔ LitVM.
Oggi (06-10): lista token in due giri RPC invece di tre, cache delle letture
pubbliche persistita in localStorage (24 h), lettura anticipata dell'altra
chain, **pagine statiche** (niente più funzione serverless per ogni click),
animazioni d'ingresso a 0,28 s, scheletro istantaneo sulla pagina coin.

### Servizi sulla VPS (Contabo, Ubuntu 24.04, utente `notus`)

- Checkout in `~/launch-pad`; Foundry in `~/.foundry/bin` (**ogni sessione
  SSH**: `export PATH="$HOME/.foundry/bin:$PATH"`); Node 22; Caddy davanti ai
  servizi con gli hostname `desk.notus-pad.fun` (e il vecchio
  `desk.notuspad.com`, da lasciar morire), `litecoin/deploy/Caddyfile`.
- `notus-points` (systemd, `points/deploy/notus-points.service`): indicizza il
  pad di Liteforge e serve `/points/*`. **Season 0 riavviata dal blocco
  57.741.789** il 04-10 (dati cancellati e servizio riavviato).
- `notus-desk` / `notus-desk-main` (desk Litecoin): la sezione è chiusa; da
  verificare se girano ancora (servono solo per eventuali claim residui).
- `contracts/.env` sulla VPS contiene `PRIVATE_KEY` e `ETHERSCAN_API_KEY`
  (solo lì, mai in chat o in un commit).

### Netlify e dominio

- Account **nuovo**: progetto `notus-pad.fun`, sottodominio
  `sensational-sprite-3334ea.netlify.app` (risponde 404 per regola, vedi §4),
  dominio primario `notus-pad.fun` su Netlify DNS, `www` reindirizza.
- Account **vecchio** (pagamento scaduto, deploy sospesi, progetti **non
  cancellabili** finché l'account è in arretrato): progetti
  `loquacious-scone-c402b4` (serviva una build vecchia del pad) e
  `elegant-biscuit-f8b901` (possedeva `notuspad.com`), entrambi **disabilitati**
  il 06-10: i loro host rispondono 404. Il dominio `notuspad.com` (comprato lì,
  denylist su X dal primo giorno) si lascia scadere.
- **Google Safe Browsing** il 06-10 ha segnalato "social engineering"
  `notuspad.com` e `loquacious-scone-c402b4.netlify.app`; `notus-pad.fun` è
  pulito. Lato hosting è tutto sistemato (404 verificati). **Mancano i passi in
  Search Console**, che l'utente non è riuscito a fare per un problema di
  login (vedi §7, punto 1).

### A metà / non confermato

- Verifica Blockscout Liteforge (sopra).
- Test del cambio wallet da parte di un amico dell'utente (il fix è online,
  commit `cf4cffe`, non ancora confermato da lui).
- Variabili Netlify `LTC_STATE_URL` e `POINTS_URL`: devono contenere
  `desk.notus-pad.fun`; non verificato se qualcuna dice ancora `notuspad.com`.
- Post di lancio su X: proposto più volte, mai scritto.
- LitVM mainnet: non esiste ancora; deploy e migrazione reale attendono.

---

## 3. Architettura e struttura

Monorepo, senza workspace: ogni cartella ha i suoi strumenti.

```
.
├── README.md            panoramica, parametri della curva, Deployments (tabella indirizzi), comandi, TODO
├── MIGRATION.md         runbook Base → LitVM mainnet, passo per passo (timelock, freeze, snapshot, bridge, ricreazione)
├── POINTS.md            design di punti, stagioni, referral e delle feature che arrivano con LitVM
├── HANDOFF.md           questo file
├── netlify.toml         build del sito (base = web, plugin Next) + regole 404 per gli host ritirati
├── .claude/launch.json  lancio del dev server (npm run dev in web/, porta 3000)
├── contracts/           Foundry (Solidity 0.8.24, optimizer 100 runs)
├── web/                 sito Next.js 16 (App Router) + wagmi/viem + TanStack Query
├── points/              servizio punti (Node 22, TypeScript eseguito direttamente)
├── litecoin/            Notus on Litecoin (chiuso): desk, indexer, payout, strumenti di migrazione, Caddyfile, unit systemd
└── zcash/               Notus on Zcash (testnet, chiuso)
```

### contracts/

- `src/Launchpad.sol` — il pad: curva, fee (1% piattaforma di cui 0,2% treasury;
  tassa della coin fino al 10% per lato, pot diviso creator/holders/burn/
  liquidità), graduazione **atomica** (`_graduate` → `_doMigrate`, nessun
  try/catch), `lockedAtGraduation`, freeze e `migrateOut` per la migrazione,
  `migrateToken`/ledger per ricreare coin da uno snapshot.
- `src/UniV2Migrator.sol` — v2: `migrate` (prezzo di chiusura fissato alla prima
  consegna, `Parked`, `PRICE_TOLERANCE_BPS=50`, `NUDGE_CAP_BPS=10`,
  `DUST_DIVISOR=10_000`), `seed()` pubblico, `unlock` restituisce il parcheggiato,
  `buyback` solo con LP propria, resti al treasury, eventi PoolParked/PoolNudged.
- `src/LaunchToken.sol`, `src/LaunchTokenFactory.sol` — la coin ERC-20 e la factory.
- `src/SlipstreamZapRouter.sol` — zap ETH → cbLTC → curva (Base).
  `src/ZapRouter.sol` (Robinhood/GIWA), `src/UniV3Migrator.sol`, `src/NotusV4Hook.sol` (Robinhood, storici).
- `script/DeployBase.s.sol` (stack Base), `script/DeployLitVM.s.sol` (pad LitVM;
  legge `NATIVE_VIRTUAL`), `script/DeployTimelock.s.sol`, `script/Deploy.s.sol`
  (GIWA), `script/DeployZap*.s.sol`, `script/MigrateFromLedger.s.sol`
  (ricrea le coin da un file di migrazione; parla al timelock con `MODE=schedule|execute`).
- `script/rehearse-liteforge.sh` — prova completa Base → Liteforge (legge
  `.env` da solo; variabili `TARGET`, `SCALE`, `GAS_MARGIN` default 0.05,
  `SRC_*`, `DST_RPC`). `script/rehearse-local.sh` — la stessa su anvil.
  `script/rehearsal/*.s.sol` — i passi della prova (RehearseSource, RehearseTarget,
  RehearseMigrateOut, RehearseCheck, Keys).
- `script/snapshot-evm.mjs` — snapshot di un pad EVM (consapevole di parked e
  locked); `script/pool-probe.mjs` — legge una pool graduata: cosa è entrato,
  cosa tiene, ogni swap (`NATIVE_SYMBOL` per chain); `script/standard-input.mjs`
  — genera lo Standard JSON per la verifica.
- `test/` — 124 test (ultimo run completo 04-10): `Launchpad.t.sol`,
  `UniV2Migrator.t.sol`, `Fees.t.sol`, `Migration.t.sol`, `Freeze.t.sol`,
  `CashbackSolvency.t.sol` (fuzz), `Timelock.t.sol`, `SelfTransferExploit.t.sol`,
  zap; **fork test** `LiveBase.fork.t.sol` contro lo stack v11 live
  (`RUN_FORK_LIVE=true`): raccolta dalle costanti, pool+lock = DEX_RESERVE,
  prezzo entro 1 bps dal chiusura, LP bloccata, zap buy e sell.
- `verify/base-v11/` (`verify-basescan.sh`, `addresses.sh`, `*.standard-input.json`,
  README), `verify/base-v10/`, `verify/base-v9/`, `verify/liteforge-v11/`
  (`verify-blockscout.sh` con diagnosi del ritardo dell'explorer).
- `foundry.toml` — rpc_endpoints (`base`, `litvm_testnet`, …) e `[etherscan]`
  (Blockscout); submodule in `lib/` (openzeppelin-contracts, forge-std, v4-core).

### web/

Stack: Next.js 16.3 (App Router, build con `--webpack`), React 19.3, wagmi
2.19.5, viem 2.55, TanStack Query 5.101.4 + `react-query-persist-client` +
`query-sync-storage-persister`, Tailwind, `@netlify/blobs` (store dei loghi),
`@noble/*`/`@scure/*` (Litecoin). Node ≥ 20.9.

Rotte (`web/app/`):
- `layout.tsx` — header (logo video, `Nav`, `ChainSwitcher`, `HeaderWallet`),
  footer, `InviteCapture`, `BottomNav`; metadata (`metadataBase` =
  `NEXT_PUBLIC_SITE_URL` o notus-pad.fun). **Non legge header di richiesta**:
  le pagine restano statiche.
- `providers.tsx` — `WagmiProvider` + `PersistQueryClientProvider`
  (localStorage `notus.queries.v1`, 24 h, solo letture pubbliche `readContract(s)`,
  escluse le funzioni legate al wallet) + `AccountEffects` (al cambio account
  invalida tutte le query).
- `page.tsx` — Explore: hero, lista (`useTokens`), volumi (`useVolumes`),
  pool delle graduate (`usePools`), `WarmTokens` per le altre chain.
- `token/[address]/page.tsx` (+ `loading.tsx`) — pagina coin: stat (mcap, in
  pool/raccolto, venduto, holders, curva), grafico, feed, `TradeBox` o
  `PoolCard`, pannelli creator/fee/cashback, `MigrationNotice`.
- `create/`, `points/`, `profile/`, `swap/`, `bridge/`, `about/` — statiche.
- `api/holders` (conteggio holder via Blockscout `/tokens/{addr}/counters`
  meno i contratti), `api/img` (proxy immagini), `api/points/[...path]` (proxy a
  `POINTS_URL`), `api/ltc-*`, `api/ltc/[...path]` (Litecoin, chiuso),
  `i/[id]` (store loghi), `opengraph-image.tsx`, `robots.ts`, `sitemap.ts`.
- `litecoin/*`, `zcash/*` — sezioni chiuse (le pagine wallet/ledger restano).

Librerie (`web/lib/`):
- `config.ts` — chain, `LAUNCHPAD_ADDRESS`, `LAUNCHPAD_DEPLOY_BLOCK`,
  `QUOTE_ASSETS` (cbLTC su Base, zkLTC su Liteforge), `ZAP_ROUTER`,
  `UNISWAP_QUOTER`, `DEX_LINKS`, `HIDDEN_TOKENS`, `RPC_URLS` (Base: mainnet.base.org,
  publicnode, drpc, 1rpc in fallback), `GETLOGS_CHUNK`, wagmi `config`
  (`ssr: true`, cookieStorage, `chains: [base, litvmTestnet, …]`, multicall batch).
  Gli host RPC stanno anche nella CSP di `next.config.mjs`.
- `hooks.ts` — `useAppChain` (chain da wagmi; prima dell'hydration dal cookie
  `wagmi.store`, letto come external store), `useTokens(chainId?, {warm})`
  (conteggio + primi 32 slot in un giro, poi nomi/curve/metadati; chiavi con
  `chainId`; segnaposto solo sulla stessa chain), math della curva
  (`spotPrice`, `marketCapOf`, `curveProgress`), `IMMUTABLE`/`META_REFETCH`.
- `events.ts` — scansione log (Bought/Sold + Swap delle pool), `useTrades`,
  `useVolumes`, cache `notus.trades.v3.*`. `pool.ts` — `usePool`/`usePools`
  (graduatedVia → pairOf/pairAsset/router → reserves). `holders.ts`,
  `price.ts` (prezzo LTC), `curve.ts` (fee config), `abi.ts`, `explorers.ts`,
  `names.ts` (nomi "mistici" dei wallet), `sanitize.ts`, `site.ts`, `format.ts`.
- `points/` — `chains.ts` (pad, blocco, season per chain: Liteforge Season 0
  da 57.741.789), `client.ts` (hook), `indexer.ts`, `rules.ts`, `referral.ts`,
  `scan.ts`, `store.ts` (usati anche dal servizio in `points/service.ts`).
- `litecoin/`, `zcash/` — sezioni chiuse.

Componenti (`web/components/`): `ConnectButton` (menu wallet), `ChainSwitcher`,
`Nav`, `BottomNav`, `HeaderWallet`, `TokenCard`, `TradeBox` (esporta
`refreshAfterTrade`), `PoolCard`, `PoolTrade`, `TradeFeed`, `PriceChart`,
`CreateTokenForm`, `FeePanel`, `FeeSplitEditor`, `CreatorPanel`, `CreatorFees`,
`CashbackCard`, `PointsCard`, `SeasonStrip`, `InviteCapture`, `InviteLink`,
`MigrationNotice`, `NotDeployedNotice`, `TokenLogo`, `TokenPicker`,
`SlippageControl`, `LiveStream`, `LogoVideo`, `WarmTokens`.

Static in `web/public/`: `googlecb18d093b1536c76.html` (verifica Search
Console, vale per ogni host che serve il sito), `retired.html` (pagina 404
degli host ritirati), `security.txt` e `.well-known/security.txt`, `art/`,
`chains/`, `fonts/`.

### points/

`service.ts` (indexer + API su 127.0.0.1:8789, dati JSON lines in
`points/data/<chain>/`), `deploy/notus-points.service`, `README.md` (API,
operatività). Usa `web/node_modules` (viem) e `web/lib/points/*`.

---

## 4. Decisioni prese (e perché)

1. **Graduazione atomica, niente try/catch** (`Launchpad._graduate` chiama
   `_doMigrate`; se la DEX fallisce, fallisce il buy che gradua). Perché: l'exploit
   del 04-10 sul pad v9 ha sfruttato la finestra tra graduazione e migrazione
   automatica fallita per gas (`AutoMigrationFailed`), seminando una pool a
   prezzo basso e facendosi "ribilanciare" dal migrator v1 (143,6 e 186,9 dei
   ~192 cbLTC raccolti di Notus e Lester).
2. **UniV2Migrator v2**: prezzo di chiusura fissato alla prima consegna,
   tolleranza 50 bps, nudge massimo 0,1%, regola della polvere (MINIMUM_LIQUIDITY
   di Uniswap), riserva **parcheggiata** se la pool esistente è troppo profonda
   e troppo economica, `buyback` solo con LP propria. Perché: non scambiare mai
   contro una pool che qualcun altro ha seminato.
3. **Apertura al prezzo di chiusura, senza sconto** (richiesta esplicita, dopo
   il confronto con Pons): `reserve = min(DEX_RESERVE, ethAmount·vToken/vEth)`,
   `lockedAtGraduation = DEX_RESERVE − reserve` (per costanti 9,52M di 200M).
   Scartate le altre idee di Pons: nessuna tassa anti-snipe, **nessun tetto per
   wallet** ("non mettere per ora nessun tetto").
4. **Riserve virtuali**: 60 cbLTC su Base (raccolta 3,2×V ≈ 192, mcap di
   apertura ≈ 0,95×V ≈ 57, mcap di graduazione 16,8×V ≈ 1.008);
   **60 zkLTC anche su LitVM mainnet** ("ok lasciamo 60 anche su litvm"),
   scritto in `MIGRATION.md` come `NATIVE_VIRTUAL=60000000000000000000`;
   **0,05 zkLTC su Liteforge** per graduare con i faucet ("va bene così tanto è testnet").
5. **Owner = timelock 24 h** su Base (proposer = deployer). Il pad di prova su
   Liteforge è del deployer, per fare in fretta.
6. **Redeploy "da capo"** dopo l'exploit (v10, poi v11 con il prezzo di
   chiusura prima che qualcuno usasse v10): il proprietario ha preferito un pad
   pulito piuttosto che convivere con i pool svuotati.
7. **Verifica contratti con Standard JSON + API degli explorer**
   (`standard-input.mjs`, Etherscan v2 API per Basescan, Blockscout v2 API per
   Liteforge): `forge verify-contract` falliva su entrambi.
8. **Solana messa da parte** per la fase cbLTC (richiesta dell'utente).
9. **Punti off-chain** (servizio sulla VPS, eventi del pad come unica verità,
   ledger ricalcolato a ogni pass), **solo su LitVM**; Season 0 di prova su
   Liteforge; nomi "mistici" dei wallet solo in header e pagine punti.
10. **Dopo la graduazione la coin resta comprabile dal sito** (router Uniswap
    v2 da `PoolTrade`), e feed/grafico/volume continuano con gli swap della pool.
11. **UI**: transizioni solo su transform/colore a 150 ms, blur ridotto,
    quote ETH debounced (250 ms), invalidazione di tutte le letture subito dopo
    un trade (`refreshAfterTrade`), entrate a 0,28 s.
12. **Un solo hostname**: gli host ritirati (`notuspad.com`, `www`, il
    sottodominio Netlify del progetto) rispondono **404 con pagina neutra, senza
    redirect**, perché una revisione di Google su un host segnalato non deve
    essere mandata su `notus-pad.fun`; il vecchio dominio era già in denylist su
    X. Regole in `netlify.toml`; la `ignore` della build ora guarda anche
    `netlify.toml` (prima un commit solo su quel file veniva saltato).
13. **Pagine statiche**: il layout non legge più `headers()` per il cookie di
    wagmi (lo faceva per fare SSR con la chain giusta e rendeva dinamica ogni
    pagina: ogni click = funzione serverless). La chain la legge il client dal
    cookie `wagmi.store` via `useSyncExternalStore` con snapshot server
    "sconosciuto": HTML uguale al server, primo fotogramma sulla chain giusta.
    Euristica in `useAppChain`: vale la parola di wagmi appena dice qualcosa di
    diverso dalla chain di default, prima quella del cookie.
14. **Cache delle query persistita** (wagmi `serialize`/`deserialize` per i
    bigint) solo per le letture pubbliche; mai saldi/allowance. `gcTime` di un
    giorno per curve/metadati così una lista riaperta dopo un'ora è immediata.
15. **Chiavi delle letture con `chainId` esplicito** in `useTokens`, così la
    lettura anticipata dell'altra chain (`WarmTokens`) riempie esattamente le
    chiavi che il cambio di chain userà; segnaposto `keepPreviousData` solo
    sulla stessa chain (evitava nomi di una chain accoppiati a indirizzi dell'altra).
16. **Holders** dal Blockscout della chain (`/tokens/{addr}/counters`) meno i
    contratti elencati nella prima pagina di holder (non una sottrazione cieca di 2).

---

## 5. Configurazione e comandi

### Variabili d'ambiente (solo nomi; i valori stanno su Netlify, sulla VPS o in `contracts/.env`)

**contracts/.env** (VPS, gitignored): `PRIVATE_KEY` (deployer/proposer),
`ETHERSCAN_API_KEY` (Basescan). Variabili degli script Foundry:
`NATIVE_VIRTUAL`, `CBLTC_VIRTUAL`, `TREASURY`, `PROPOSER`, `TIMELOCK`,
`TIMELOCK_DELAY`, `UNIV2_ROUTER`, `LAUNCHPAD`, `MIGRATION_FILE`, `MODE`,
`FORK_RPC`, `RUN_FORK`, `RUN_FORK_LIVE`; della prova: `TARGET`, `SCALE`,
`GAS_MARGIN`, `SRC_RPC`, `DST_RPC`, `SRC_PAD`, `SRC_QUOTE`, `SRC_FROM`; dei kit
di verifica: `FIRST_TOKEN`, `FIRST_NAME`, `FIRST_SYMBOL`, `FORCE`. Nella
sandbox di Claude serve `FOUNDRY_SOLC=$HOME/.solc/solc-0.8.24`.

**Sito (Netlify, progetto `notus-pad.fun`)**: `NEXT_PUBLIC_SITE_URL`,
`NEXT_PUBLIC_SOURCE_URL` (o `off`), `NEXT_PUBLIC_WC_PROJECT_ID` (Reown/WalletConnect),
`PINATA_JWT` (loghi su IPFS; senza, lo store locale), `LOGO_GC_SECRET`
(cron di pulizia loghi), `POINTS_URL` (`https://desk.notus-pad.fun/points`),
`LTC_STATE_URL`, `LTC_API_UPSTREAM`, `LTC_API_KEY`, `NEXT_PUBLIC_LTC_NETWORK`,
`NEXT_PUBLIC_LTC_API` (sezione Litecoin, chiusa).

**Servizio punti** (nell'unit): `PORT`, `NOTUS_POINTS_CHAINS`,
`NOTUS_POINTS_DATA`, `NOTUS_POINTS_EVERY`.

**Desk Litecoin** (chiuso): `NOTUS_LTC_*` (`API`, `API_KEY`, `CACHE`,
`CONFIRMATIONS`, `DESK`, `DESK_DIR`, `DESK_KEY`, `DESK_KEY_FILE`, `FREEZE`,
`INDEX_EVERY`, `MAX_ROUND_LIT`, `NETWORK`, `PAYOUT_EVERY`, `SENT`, `STATE`).

### Installare

```bash
git clone https://github.com/giupy997/launch-pad && cd launch-pad
git submodule update --init --recursive        # openzeppelin, forge-std, v4-core in contracts/lib
cd web && npm install && cd ..
curl -L https://foundry.paradigm.xyz | bash && foundryup   # forge/cast/anvil, se mancano
```

### Sito: sviluppo, controlli, build

```bash
cd web && npm run dev            # http://localhost:3000
cd web && npx tsc --noEmit       # tipi
cd web && npx eslint .           # un warning preesistente in app/swap/page.tsx (minOut) è normale
cd web && npm run build          # il gate prima di ogni commit che tocca il sito
```

Test unitari del sito (nessuna rete):

```bash
cd web && node --test --experimental-strip-types lib/points/*.test.ts lib/sanitize.test.ts
```

### Contratti

```bash
cd contracts && forge test                                   # 124 test
cd contracts && RUN_FORK_LIVE=true forge test --match-contract LiveBase -vv   # lo stack v11 live su fork
cd contracts && node script/pool-probe.mjs --rpc https://mainnet.base.org --launchpad 0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4 --from-block 52180589
cd contracts && bash verify/base-v11/verify-basescan.sh      # legge addresses.sh e ETHERSCAN_API_KEY da .env
cd contracts && bash verify/liteforge-v11/verify-blockscout.sh
cd contracts && bash script/rehearse-liteforge.sh            # prova Base → Liteforge (TARGET= per riusare un pad)
```

Deploy (vedi `MIGRATION.md` §1 per LitVM e il README per Base). Schema:

```bash
cd contracts && source .env && forge script script/DeployBase.s.sol --rpc-url base --private-key "$PRIVATE_KEY" --broadcast
cd contracts && source .env && NATIVE_VIRTUAL=60000000000000000000 forge script script/DeployLitVM.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

### Deploy del sito

Automatico: ogni push su `main` fa partire la build Netlify (base `web/`,
`@netlify/plugin-nextjs`). La `ignore` in `netlify.toml` salta la build se non
cambia nulla sotto `web/` né `netlify.toml`. Dopo il deploy, per verificare le
regole degli host:

```bash
curl -sI https://notus-pad.fun/ | head -1                                  # 200
curl -sI https://sensational-sprite-3334ea.netlify.app/ | head -1          # 404
curl -sI https://notuspad.com/ | head -1                                   # 404
```

### VPS

```bash
ssh notus@desk.notus-pad.fun          # l'host è quello a cui punta desk.notus-pad.fun; password dell'utente
export PATH="$HOME/.foundry/bin:$PATH"
cd ~/launch-pad && git pull -q && (cd web && npm install --no-audit --no-fund)
sudo systemctl restart notus-points && journalctl -u notus-points -f
curl -s https://desk.notus-pad.fun/points/health
sudo cp litecoin/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Per riavviare la Season 0 da zero: `sudo systemctl stop notus-points`,
cancellare `~/launch-pad/points/data/liteforge/`, `sudo systemctl start notus-points`.

### Git

```bash
git -c user.name="giupy997" -c user.email="giupy997@gmail.com" commit -F - <<'MSG'
<titolo in inglese>

<corpo>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013AyUzwaeMQGo7hqLRdR8eq
MSG
for d in 0 2 4 8 16; do sleep $d; git push -u origin main && break; done
```

Si pusha **direttamente su `main`**, niente pull request.

---

## 6. Problemi noti e bug aperti

1. **Search Console non ancora fatto**: aggiungere la proprietà
   `https://notus-pad.fun/` (prefisso URL, verifica "file HTML": il file è già
   servito) e chiedere il controllo sulle due proprietà segnalate
   (`notuspad.com`, `loquacious-scone-c402b4.netlify.app`) con i testi in §7.
   Finché Google non rivede, Chrome avvisa su quei due host (non sul pad).
2. **Verifica Blockscout del pad Liteforge v11** in sospeso per il ritardo
   dell'explorer.
3. **Account Netlify vecchio in arretrato**: i due progetti sono disabilitati
   ma non cancellabili; da chiudere o declassare il team da "Review options"
   perché il debito non cresca. Zona DNS di `notuspad.com` ancora viva (non
   rinnovare).
4. **Variabili Netlify** `LTC_STATE_URL`/`POINTS_URL` da controllare
   (`desk.notus-pad.fun`); quando `notuspad.com` scadrà, `desk.notuspad.com`
   morirà con lui.
5. **Cambio wallet**: fix online (`cf4cffe`), test dell'amico non confermato.
6. **eslint**: un warning `react-hooks/exhaustive-deps` in `web/app/swap/page.tsx`
   riga ~142 (`minOut`), preesistente, lasciato.
7. **Pad v9 su Base**: pool svuotate dall'exploit; chi aveva comprato Notus/
   Lester lì ha perso valore. Non si lancia più nulla lì. La prima coin del
   proprietario e quella dell'amico sono state ricreate su v11.
8. **RPC pubblici lenti** (Base) e **Liteforge senza multicall3** (letture
   singole raggruppate in batch HTTP): la prima apertura a freddo resta ~1,5 s;
   dopo è istantanea grazie alla cache persistita.
9. **Pagina coin** costruita dal server alla prima visita di ciascuna coin
   (poi in cache CDN): scheletro immediato, contenuto dopo il primo giro.
10. **Euristica di `useAppChain`**: usa il cookie finché wagmi risponde la
    chain di default (Base). Funziona perché wagmi riscrive il cookie a ogni
    cambio; se un giorno la chain di default cambia, rileggere quel punto.
11. **GIWA Sepolia** pad v7.1 (redeploy v7.4 in sospeso da tempo, bassa priorità).
12. **TODO del README** ancora aperti: adapter DEX su GIWA, test end-to-end con
    MetaMask su GIWA, policy di deploy su GIWA mainnet, **revisione legale
    (MiCA) prima del lancio pubblico**.
13. Nella **sandbox di Claude** non si raggiungono RPC, explorer, Netlify né i
    docs di Netlify/Google (proxy): i comandi di rete li esegue l'utente sulla
    VPS e incolla l'output.

---

## 7. Prossimi passi, in ordine di priorità

1. **Search Console** (5 minuti, appena l'utente riesce a entrare con
   l'account Gmail che riceve le email):
   - Aggiungi proprietà → Prefisso URL → `https://notus-pad.fun/` → File HTML
     (`googlecb18d093b1536c76.html`, già online) → Verifica. Poi Sicurezza e
     azioni manuali → Problemi di sicurezza: deve dire "Nessun problema rilevato".
   - Per `https://notuspad.com/`: Problemi di sicurezza → Richiedi un controllo,
     testo: *"This domain has been retired. The hosting project behind it has
     been disabled and taken offline, so the domain serves no content, and it
     will not be renewed. Nothing on this hostname asks visitors for anything."*
   - Per `https://loquacious-scone-c402b4.netlify.app/`: *"This hostname
     belonged to an earlier deployment of our site at the hosting provider
     (Netlify). That project has been disabled and taken offline: the hostname
     serves nothing of ours and no content is published there. Nothing on it
     asks visitors for anything."*
   - Stato pubblico del pad: https://transparencyreport.google.com/safe-browsing/search?url=notus-pad.fun
2. **Verifica Liteforge**: sulla VPS `cd ~/launch-pad && git pull -q && cd contracts && bash verify/liteforge-v11/verify-blockscout.sh`
   (prima `export PATH="$HOME/.foundry/bin:$PATH"`). Se l'explorer è ancora
   indietro, riprovare il giorno dopo.
3. **Conferma del cambio wallet** dall'amico (Disconnect → altro wallet, oppure
   "Switch wallet" dal menu): se serve ancora un hard refresh, chiedere quale wallet.
4. **Netlify, progetto nuovo → Environment variables**: `LTC_STATE_URL` e
   `POINTS_URL` su `desk.notus-pad.fun`; dopo una modifica, Trigger deploy →
   Clear cache and deploy (se Netlify lo segna Skipped, un commit qualunque
   sotto `web/` forza la build).
5. **Post di lancio su X** (@Notuspad), in inglese: sito veloce, contratti
   verificati, dominio pulito. Toni fattuali, nessuna promessa di prezzo.
6. **Monitoraggio** (UptimeRobot o simile) su `https://notus-pad.fun/` e
   `https://desk.notus-pad.fun/points/health`.
7. **Chiudere il vecchio account Netlify** quando possibile; lasciar scadere
   `notuspad.com`; togliere `desk.notuspad.com` dal `Caddyfile` quando il DNS
   non risolve più.
8. **LitVM mainnet** quando esiste: seguire `MIGRATION.md` dall'inizio
   (`~/notus-litvm.env`, pad con `NATIVE_VIRTUAL=60000000000000000000`,
   timelock 48 h, annuncio del freeze via timelock, snapshot, `migrateOut`,
   cbLTC → LTC → zkLTC, `MigrateFromLedger`, pubblicazione). Prima: una nuova
   prova su Liteforge con un pad fresco (`rehearse-liteforge.sh` senza `TARGET`).
9. **Revisione legale (MiCA)** prima di una promozione pubblica seria.
10. Facoltativo: uno swap dalla `PoolCard` della coin TEST su Liteforge per
    vedere un trade "pool" nel feed; redeploy GIWA v7.4.

---

## 8. Riepilogo cronologico

Gli hash sono su `main`. Prima del 30-09: la sezione Litecoin (ledger su
OP_RETURN, desk custodial), i pad GIWA/Robinhood, il design della migrazione a
LitVM.

- **30-09** — Il pad per Base quotato in cbLTC (`cbe963f`, `e56c101`), lo zap
  su Aerodrome Slipstream (`e9d273c`, `54260a4`), Launchpad v8 con la via
  d'uscita per la migrazione (`2cab0e3`) e v9 con le fee della coin
  (`2fd441a`, review fissate `7540e39`), runbook della migrazione
  (`af8cb5c`), Notus on Litecoin chiuso (`c2d25fb`), Next 16 / React 19
  (`5525706`), CSP (`813c26c`). Stack v9 live su Base (`38f89e1`).
- **01-10** — v9 rideployato a 60 cbLTC di virtuale (`ef598ae`); sito: mcap,
  volume, più RPC (`bf55263`), approve una volta (`631e551`), campo che si
  azzera al cambio lato (`18626dd`), saldo e 25/50/75/Max (`b549ef2`);
  verifica su Basescan documentata (`9072e83`).
- **02-10** — Scansioni log adattive (`64a26f6`, `279d7ab`); design punti e
  referral (`57fe297`), servizio punti per Liteforge (`eaf4c01`), sito con
  punti e inviti (`3d28579`); prova della migrazione Base → Liteforge
  (`8f276d1`, snapshot con `--scale` `5df0929`); nomi mistici (`232e396`,
  `7348712`); verifica Basescan via Etherscan v2 API + Standard JSON perché
  `forge verify` falliva (`07b9857`, `13a738a`, `2bd145f`).
- **04-10 (mattina)** — L'utente vede "migrati" i token con mcap a 12 $: il
  `pool-probe.mjs` (`8fc121b`) ricostruisce l'**exploit** del blocco
  52.105.142 sul pad v9 (tx `0xf1e2…8de4`). Decisione: rifare da capo.
  Graduazione atomica + migrator v2 (`9958529`), trading post-graduazione sul
  sito (`32bddef`), stack **v10** deployato e verificato (`501f833`, `4adb55a`),
  fork test dello stack live (`c6c1210`): il test all'1% fallì per lo sconto
  strutturale del 4,8% (`e52e855`), da cui, dopo il confronto con Pons, la
  scelta dell'**apertura al prezzo di chiusura** (`1288d44`). **v11** deployato
  su Base e su Liteforge (`b9b3c5b`), kit di verifica Liteforge (`30a7155`,
  `f8cb2ec`: l'explorer era indietro). Season 0 riavviata dal blocco v11.
- **05-10** — Prova della migrazione nel pad v11 di Liteforge: prima corta di
  zkLTC (faucet + `GAS_MARGIN`, `e2cb360`), poi ALL PASS a scala 1:1000
  (`72fa6de`); fork LiveBase 3/3 su v11. Coin TEST graduata dal vivo su
  Liteforge, esattamente al prezzo di chiusura. Feed/grafico/volume con gli
  swap della pool (`ddf38d0`), stat Holders (`2091085`, corretta `a93debe`),
  pool reads con retry (`247a050`); deciso 60 zkLTC per LitVM mainnet
  (`9bbbace`); UI più rapida (`7225d44`). L'utente chiede di non mettere tetti
  per wallet e di lasciare 0,05 su Liteforge.
- **06-10** — Menu wallet opaco, Switch wallet, refresh al cambio account
  (`cf4cffe`). Email Google Safe Browsing su `notuspad.com` e sul sottodominio
  Netlify vecchio: regole per gli host in `netlify.toml` (prima 301 `a88c080`,
  poi **404 senza redirect** `fe0dc48`), la `ignore` corretta (`cafc53a`), la
  regola sul sottodominio giusto una volta capito che gli account Netlify sono
  due (`d211343`); i due progetti vecchi disabilitati dall'utente (non
  cancellabili per l'arretrato): 404 verificati. Explore in due giri RPC, cache
  persistita, lettura anticipata dell'altra chain, niente "(0)" (`4b454a3`).
  Lag al cambio sezione: `headers()` nel layout rendeva dinamica ogni pagina;
  **pagine statiche**, chain dal cookie lato client, animazioni 0,28 s,
  `loading.tsx` della pagina coin (`9922ffe`). L'utente conferma: "ora è veloce".

Cosa **non** ha funzionato e come è stato risolto: `forge verify-contract`
su Basescan e Blockscout (→ Standard JSON + API); il fork test all'1% (→ cambio
di design, 1 bps su v11); la prova corta di zkLTC (→ faucet, `GAS_MARGIN`); lo
Stack too deep nei test (→ helper); i redirect 301 dagli host ritirati (→ 404);
commit solo su `netlify.toml` saltati dalla build (→ `ignore` estesa); la
regola sul sottodominio sbagliato (→ due account Netlify, chiarito dagli
screenshot); il sito fermo su "Reading the pool…" (→ retry delle letture
immutabili); Holders a 0 (→ sottrarre solo i contratti elencati); il generico
del segnaposto non dedotto da TypeScript (→ generico sulla funzione restituita);
il `Date.now` nel render segnalato da eslint (→ `swapDeadline()` fuori dal
componente).

---

## 9. Convenzioni di lavoro con il proprietario

- Risponde e legge in **italiano**; copy del sito, README e messaggi di commit in **inglese**.
- Comandi per la VPS **uno per blocco di codice** ("i codici scrivimeli uno per uno").
- **Mai** chiavi o segreti in chat né nel repo: solo nomi di variabili; i valori
  vivono su Netlify, sulla VPS e in `contracts/.env`. Niente `<placeholder>` nei
  comandi: usare variabili di shell.
- Ogni commit che tocca `web/` passa prima `npm run build` (più `npx tsc --noEmit`
  e `npx eslint .`); push diretto su `main`, nessuna PR.
- Dalla sandbox non si raggiungono RPC, explorer e dashboard: l'utente esegue
  e incolla l'output. Chiedere screenshot quando una schermata non torna.
- Stile del codice e dei commenti: frasi piene che dicono il perché, come negli
  esempi di `netlify.toml`, `app/providers.tsx`, `lib/hooks.ts`.
