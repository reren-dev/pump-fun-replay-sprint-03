# pump-fun-replay-sprint-03

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reren-dev/pump-fun-replay-sprint-03/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reren-dev/pump-fun-replay-sprint-03/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A minimal deterministic paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity: it buys new coins once real buy volume (≥ 1.5 SOL) and a ≥ 5% rise show momentum, sizes each entry at most 0.10 SOL, holds at most 5 positions, and exits on +30% take-profit, −15% stop-loss, after 8000 slots, or when the coin completes. Every decision is a pure function of the replay messages, so two runs produce byte-identical action logs.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdio: it reads `hello` / `batch` / `done` NDJSON lines on stdin and writes one `reply` per batch on stdout. No dependencies, no network, no clock — Node 22 runs the TypeScript as-is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zesty-harbor-18&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
