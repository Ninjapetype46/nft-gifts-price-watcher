# Contributing

Thanks for helping. Bug reports, fixes and verified API details are all welcome, especially for anything marked `TODO(verify)`.

## Set up and test

You need Node.js 22.13 or newer.

```bash
npm ci
npm test
node src/index.js mock --cycles 2
```

Both must pass before you open a pull request. Tests and `mock` run offline and need no keys. If you add a feature, add offline tests for its logic, and fixtures in `src/clients/mock.js` so the `mock` run shows it. Files the mock reads at runtime go under `src/mock/fixtures/`.

## The safety rule

Never weaken a safety default. In particular:

- `DRY_RUN=true` stays the default and stays a hard lock: no bot command or stored setting may lift it.
- Live mode keeps needing `DRY_RUN=false` in `.env` plus `/dry off` and its confirm button, and `DRY_RUN=true` keeps voiding an earlier live confirmation.
- Auto-pause and `/panic` keep stopping every buy, the manual Confirm buy included.
- Every spend path checks `MAX_PRICE_TON`, `DAILY_BUDGET_TON` and `MAX_BUYS_PER_HOUR` against the all-in cost, and the `.env` values stay ceilings.
- `/panic` must keep stopping all buying at once, including a buy that is already in progress.
- New autobuy rules start in shadow mode, and autobuy buys green items only.
- Secrets (bot token, API keys, wallet words) are never logged in full and never requested in chat.

Pull requests that relax these will not be merged.

## Code style

- Node.js 22.13+, ES modules, no build step. Keep runtime dependencies to a minimum. Anything only needed for live buying goes in `optionalDependencies` and is loaded with `import()`.
- Keep the math pure: `valuation.js`, `detector.js`, `edge.js`, `risk.js`, `paper.js` and `portfolio.js` do no I/O, and the clock is passed in.
- API-specific code lives in `src/clients/`. Mark any guess about an external API with `TODO(verify)`.
- Every price shown to the user is net of fees, royalty and gas.
- Everything is in English: code, comments, bot strings, CLI output and docs.
- Two-space indent, single quotes, semicolons. Match the style of the surrounding code.
