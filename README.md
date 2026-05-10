# tf2-easycrafter

A TF2 inventory + crafting CLI. Crafts metal/scrap, audits your backpack for value, and lists dupes on backpack.tf and Steam Market — without launching the full game.

> **Status: experimental / WIP.** Talks to Steam and the TF2 Game Coordinator directly. Read the warnings below before pointing it at a populated backpack.

## Features

- **`status`** — Backpack usage, metal counts, scrappable weapon count, tokens.
- **`review`** — Full backpack analysis: categorized inventory, dupe detection (clean Unique + modified instances), weapon junk yield with class-pair simulation, total inventory value in refined and USD, top holdings, top single-item values, prioritized recommendations.
- **`reco`** — Numbered, ranked action list from the last review. Each rec is tagged `(auto)` or `(manual)`.
  - **`reco do <N>`** — Execute craft recs (smelt weapons, combine metal). No marketplace argument.
  - **`reco do <N> bptf`** — Sell rec → list on backpack.tf classifieds (refined metal, no fee).
  - **`reco do <N> steam`** — Sell rec → list on Steam Market (USD, ~15% fee, Steam Wallet only).
  - **Batch syntax**: `reco do 3,4,5 bptf` or `reco do 3-7 steam` or `reco do 1,3-5,7 bptf`. Single batch confirmation, sequential execution, manual recs in the selection are skipped automatically. backpack.tf inventory refresh runs once per batch instead of per item.
  - Sell recs **require** an explicit marketplace; running without one prints both options for you to pick.
- **`weapons`** — Full list of weapon stacks (2+ same item) with quality breakdown and per-quality prices. Shows what you'd destroy by smelting.
  - **`weapons smelt <N>`** — Smelt pairs from a chosen stack. Bypasses the default melee/sniper protection so you can deliberately scrap modified items.
- **`makescrap`**, **`smelt <metal>`**, **`combine <metal>`** — Direct crafting commands.
- **`junk`** — List of scrappable items per default junk config.
- **`menu`** — Toggle TF2 main-menu HUD tweaks (e.g. hide friends list). Patches `gameinfo.txt` so a custom HUD VPK loads. TF2 must be closed.
  - **`menu hidefriends [on|off]`** — Apply / remove the hidden-friends-list overlay.
- **`forgetme`** — Clears the cached Steam refresh token (forces re-login on next run). Also available as a CLI flag: `node src/runCli.js --forget`.

Pricing is fetched from backpack.tf's `IGetPrices/v4` endpoint and cached locally for an hour. Steam Market USD conversion uses the live Mann Co. Supply Crate Key price.

## Install / Run

```sh
git clone <repo>
cd tf2-easycrafter
npm install
node src/runCli.js
```

> **Why `node src/runCli.js` and not `npm start`?** On Windows + PowerShell, `npm start` doesn't pass stdin through correctly, so the CLI prompt appears but accepts no input. `node` directly works everywhere.

First run prompts for your Steam credentials + Steam Guard. The login token is cached at `data/refresh_token.json`; subsequent runs log in silently. Use `node src/runCli.js --forget` to clear.

## .env configuration

The CLI reads a gitignored `.env` from the project root. All settings are optional — without them, the CLI runs in offline mode (no prices, no listings).

```env
# backpack.tf developer API key (read-only price data).
# Generate at: https://backpack.tf/developer/apikey
# Format: 24-char hex.
BPTF_API_KEY=your-dev-key-here

# backpack.tf user token (write-capable: lets us create classifieds listings).
# Connections settings on backpack.tf.
# Format: base64. KEEP PRIVATE — controls your backpack.tf account.
BPTF_USER_TOKEN=your-user-token-here
```

`BPTF_API_KEY` enables the price-aware view (`review` shows ref values, ranked dupes, total inventory worth).
`BPTF_USER_TOKEN` enables `reco do <N>` to actually post sell listings on backpack.tf.

Steam Market listing reuses the existing Steam login session — no extra credentials needed in `.env`. You confirm each listing on your Steam mobile app.

## Marketplace differences

|                         | backpack.tf classifieds                      | Steam Market                                       |
| ----------------------- | -------------------------------------------- | -------------------------------------------------- |
| Currency                | Refined metal                                | USD (or your wallet currency)                      |
| Steam fee               | None                                         | ~15% (10% Steam + 5% TF2)                          |
| Cash out                | n/a (item-for-item trade)                    | No — funds locked to Steam Wallet                  |
| Buyer reach             | TF2 traders                                  | Largest pool, fastest sales                        |
| How a sale happens      | Buyer sends you a Steam trade offer; you accept | Centralized — Valve handles the trade            |
| Per-listing confirmation | None                                          | Steam mobile app tap per listing                   |
| Auth needed              | `BPTF_USER_TOKEN`                            | Logged-in Steam session (auto)                     |

## Aliases

Most commands have shortcuts so you don't type them in full:

| Full | Aliases |
| --- | --- |
| `help` | `h` |
| `quit` | `q`, `exit` |
| `status` | `s`, `inv` |
| `review` | `r`, `analyze` |
| `reco` | `recs`, `recommendations` |
| `weapons` | `w`, `stacks` |
| `junk` | `j`, `scrappable` |
| `makescrap` | `scrap` |
| `forgetme` | `forget` |

Slashes in front (`/review`) are stripped automatically — Minecraft muscle memory is fine.

## Typical workflow

```
TF2-CLI> review
   [1] [HIGH]    Sell 16× Name Tag @ 15.90 ref ea (~254 ref)  (auto)
   [2] [HIGH]    Sell 3× Violet Vermin Case @ 17.60 ref ea    (auto)
   [3] [INFO]    Sell 5× Battle-Worn Robot Taunt Processor    (auto)
   ...

TF2-CLI> reco do 1 bptf           # post 16 Name Tags on backpack.tf classifieds
TF2-CLI> reco do 2 steam          # post Vermin Cases on Steam Market
TF2-CLI> reco do 3                # craft rec (no marketplace) — smelt or combine metal
TF2-CLI> reco do 3-7 bptf         # batch: list recs 3,4,5,6,7 in one pass
TF2-CLI> reco do 1,3-5,7 steam    # batch with mixed list and range

TF2-CLI> weapons                  # see every multi-instance weapon stack
TF2-CLI> weapons smelt 3          # smelt all of stack #3 (with value warning)
```

## Warnings

- **Real items.** Crafts are irreversible and the Steam Game Coordinator processes them immediately. Always read the confirmation prompt.
- **Smelting destroys value.** Strange / Vintage / Killstreak / painted weapons sell for 5-500× their plain Unique price. The CLI warns before destructive smelts; heed the warning.
- **Steam Market funds are wallet-locked.** Selling on Steam Market means trading items for Steam Wallet credit (not cash). Use backpack.tf for tradable refined.
- **`BPTF_USER_TOKEN` is account-control.** It can list, delist, and modify your backpack.tf account. Don't paste it into chats, screenshots, or Discord. Rotate at backpack.tf → Connections if exposed.
- **Brand-new backpack.tf accounts** need their inventory indexed before listing API calls work. If `reco do N` returns "Item could not be resolved", load `https://backpack.tf/profiles/<your_steamid>` once in a browser to bootstrap the index.

## Layout

```
src/
  runCli.js          Entry point — loads .env, starts engine + CLI
  cli.js             Command parser + handlers
  tf2Engine.js       Steam login, GC connection, backpack loading
  crafter.js         Smelt/combine/junk recipes
  reviewer.js        Inventory analysis + recommendations
  priceClient.js     backpack.tf IGetPrices client (cached 1h to .cache/)
  sellClient.js      backpack.tf classifieds v2 client
  steamMarketClient.js  Steam Market sell client (uses steam-user web session)
  menuTweaks.js      Main-menu HUD VPK toggles (gameinfo.txt patcher, hide-friends overlay)
  envLoader.js       Tiny .env reader (no dependency)
  constants.js       Log levels + ANSI colors
  tf2Constants.js    Item qualities, slot/class tokens, protected weapons
data/                Login token + steam-user cache (gitignored)
.cache/              Price snapshots (gitignored)
.env                 Your config (gitignored)
```

## License

MIT.
