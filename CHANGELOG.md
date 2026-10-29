# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-28

First public release.

### Added

- Deal alerts for Getgems collections, Telegram gifts included: a listing under your price cap, below the next cheapest listing, or below fair value. Each card has the "Why" in plain words and Open, Paper buy (Buy… in live mode), Why?, Comps and Mute 24h buttons.
- Honest price: fair value from comparable sales by model, backdrop, symbol and collection. A wash filter removes Getgems-flagged sales, round trips and repeated wallet pairs, and a per-level outlier filter removes the rest of the noise. Every price has a confidence grade (A, B or C), and a comps receipt is available from the Comps button and `valuate --explain N`.
- Profit card: all-in cost, net resale after marketplace fee, royalty and gas, break-even resale, time to sell, a fiat line, and an instant exit from open bids (EXIT-BACKED). Alerts that lose money after fees, and illiquid ones, arrive silently.
- "Safe to buy?" light with eight checks: official gift collection, sale type, Fragment ban, fresh price, Getgems status, seller history, "too good to be true" and data confidence. A pre-buy checklist comes before Confirm buy.
- `/mygifts`: what the gifts on your Telegram profile, or any wallet or `name.ton`, are worth, with a daily drop alert, a seller guard and "someone pays more" alerts. Without a Getgems key, gift collections are found by name among TonAPI-verified accounts. Every valued gift is on the card, so the total adds up. `/forget` deletes the stored addresses and snapshots.
- Paper scoreboard: practice buys marked net of fees, lost races, skip reasons, a go-live readiness check and a reduced budget for the first 24 hours of live mode.
- Autobuy rules with a max price and a discount, plus optional net edge, time to sell, bid cover and a cross-market check. Buys go through Getgems' transaction builder or straight to the on-chain sale contract, from a v4r2 or v5r1 wallet.
- Free sales history without a paid key, sampled from on-chain purchase events via TonAPI, with the source shown on every card.
- Explained decisions: `/why` for every alert, buy and skip, a `decisions` table, a JSONL event log, a daily digest with tuning hints, and an optional "Explain more" button using Claude.
- Shadow rules with hindsight cards, `/scoreboard`, `/digest`, `/mute`, `/compare` and `/preset`.
- Cross-market floors: this bot's floors written to `data/floors.json` every cycle, floors from other markets read from `PEER_FLOORS`, and a skipped buy when the same model is cheaper elsewhere.
- CLI commands `run`, `once`, `mock`, `valuate`, `portfolio`, `scoreboard`, `doctor`, `gifts` and `wallet`.
- Offline `mock` mode with fixture collections that shows every feature, and 185 offline tests.
- Windows install (README: Self-hosting) and a GitHub Actions workflow that runs the tests and the mock.

### Safety

- `DRY_RUN=true` by default, as a hard lock that no bot command or stored setting can override. Setting it voids an earlier live confirmation. Live mode needs `DRY_RUN=false`, `/dry off` and a confirm button, and `/dry off` refuses while the wallet words or the optional wallet packages are missing.
- Spending limits (`MAX_PRICE_TON`, `DAILY_BUDGET_TON`, `MAX_BUYS_PER_HOUR`) on the all-in cost of every buy. The `.env` values are ceilings, and stored overrides above them are capped when read.
- One guarded buy path for autobuy and the Buy button, with buys run one at a time. The listing is re-read and the transaction validated before signing.
- `/panic` stops all buying at once, including a buy that is already in progress, forces practice mode and voids pending confirmations. `/resume` needs a confirmation. Confirm buy, "Yes, spend real TON" and "Yes, resume" expire after 15 minutes.
- Auto-pause after repeated buy errors, an unexplained wallet balance drop or stale data. It stops every buy, Confirm buy included, until `/resume`. Autobuy also holds while Getgems reports an incident.
- `mock` never contacts Telegram, even with a bot token in `.env`. `doctor` checks the bot token with Telegram, `ADMIN_IDS` and the wallet packages, and measures clock skew from the HTTP `Date` and `Age` headers.
- New autobuy rules start in shadow mode. Autobuy buys green items only, red items get no Confirm button, and live autobuys above `CONFIRM_ABOVE` ask first.
- A live buy is recorded before it is sent. A send that may have gone out stays `pending` and counts against the limits.
- Secrets are never logged in full. `/doctor` prints key names only, and the bot never asks for wallet words in chat.

### Known limitations

- No real purchase has been sent yet. Live sending from the wallet is untested.
- Every Getgems endpoint that needs the paid key was written from the OpenAPI spec and has not run live. Several units and response shapes are marked `TODO(verify)`.
- Fee and royalty fallbacks (5% + 5%) are estimates, used when a listing does not expose its own fees.
- Without a Getgems key, the sales history is a sample, there are no open bids, gift collections can't be verified as official (so green-only autobuy skips them unless you allow-list them), and off-chain gift listings are not seen.
- The Telegram bot and `/mygifts` profile reading are covered by offline tests only.
- Bot strings are English only.
- `npm audit` reports GHSA-mrhx-c7xc-m3w5 (high) in the zod 3 copy bundled by the optional `@ton/ton`. No fix is available upstream. It loads only for live buying.
